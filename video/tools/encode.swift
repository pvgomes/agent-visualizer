// The launch video's encoder: H.264 through VideoToolbox, AAC through AVFoundation, no ffmpeg.
//
//   encode video <out.mp4> <width> <height> <fps> <bitrate>
//       reads PNG frames from stdin, each prefixed by its length (4 bytes, big-endian), and
//       writes them as frame 0, 1, 2, ... at <fps>, tagged BT.709. Frames of another size are
//       scaled to <width>x<height> (smoothly; at their own size they are copied pixel for pixel).
//   encode mux <video.mp4> <audio.m4a> <out.mp4>
//       copies both streams (no re-encode) into one MP4, cut to the video's length.
//   encode probe <file.mp4>
//       prints duration, size, frame rate, codecs and bitrate.
//   encode frames <file.mp4> <outdir> <t1,t2,...>
//       decodes the frames at those seconds to PNG (to check the encode, not the render).
//
// Build: swiftc -O -swift-version 5 encode.swift -o encode
import AVFoundation
import CoreGraphics
import CoreVideo
import Foundation
import ImageIO

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(1)
}

func readExactly(_ n: Int) -> Data? {
  var out = Data()
  out.reserveCapacity(n)
  while out.count < n {
    let chunk = FileHandle.standardInput.readData(ofLength: n - out.count)
    if chunk.isEmpty { return out.isEmpty ? nil : out }
    out.append(chunk)
  }
  return out
}

func video(out: String, w: Int, h: Int, fps: Int32, bitrate: Int) {
  let url = URL(fileURLWithPath: out)
  try? FileManager.default.removeItem(at: url)
  guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { fail("can't create \(out)") }
  let color: [String: Any] = [
    AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
    AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
    AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
  ]
  let settings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: w,
    AVVideoHeightKey: h,
    AVVideoColorPropertiesKey: color,
    AVVideoCompressionPropertiesKey: [
      AVVideoAverageBitRateKey: bitrate,
      AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
      AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC,
      AVVideoExpectedSourceFrameRateKey: fps,
      AVVideoMaxKeyFrameIntervalKey: Int(fps) * 2,
      AVVideoAllowFrameReorderingKey: true,
    ],
  ]
  let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
  input.expectsMediaDataInRealTime = false
  let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: w,
    kCVPixelBufferHeightKey as String: h,
    kCVPixelBufferCGImageCompatibilityKey as String: true,
    kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
  ])
  writer.add(input)
  guard writer.startWriting() else { fail("startWriting: \(writer.error?.localizedDescription ?? "?")") }
  writer.startSession(atSourceTime: .zero)
  let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
  var n: Int64 = 0
  while let len = readExactly(4) {
    if len.count < 4 { break }
    let size = len.withUnsafeBytes { Int(UInt32(bigEndian: $0.loadUnaligned(as: UInt32.self))) }
    guard let png = readExactly(size), png.count == size else { fail("short frame \(n)") }
    guard let src = CGImageSourceCreateWithData(png as CFData, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fail("bad png at frame \(n)") }
    guard let pool = adaptor.pixelBufferPool else { fail("no pixel buffer pool") }
    var pbOut: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pbOut)
    guard let pb = pbOut else { fail("no pixel buffer") }
    CVBufferSetAttachment(pb, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
    CVBufferSetAttachment(pb, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
    CVBufferSetAttachment(pb, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
    CVPixelBufferLockBaseAddress(pb, [])
    let ctx = CGContext(
      data: CVPixelBufferGetBaseAddress(pb), width: w, height: h, bitsPerComponent: 8,
      bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: srgb,
      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
    ctx.interpolationQuality = img.width == w && img.height == h ? .none : .high
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    CVPixelBufferUnlockBaseAddress(pb, [])
    while !input.isReadyForMoreMediaData { usleep(1000) }
    if !adaptor.append(pb, withPresentationTime: CMTime(value: n, timescale: fps)) {
      fail("append failed at frame \(n): \(writer.error?.localizedDescription ?? "?")")
    }
    n += 1
  }
  input.markAsFinished()
  let done = DispatchSemaphore(value: 0)
  writer.endSession(atSourceTime: CMTime(value: n, timescale: fps))
  writer.finishWriting { done.signal() }
  done.wait()
  if writer.status != .completed { fail("finishWriting: \(writer.error?.localizedDescription ?? "?")") }
  print("encoded \(n) frames -> \(out)")
}

func mux(videoPath: String, audioPath: String, out: String) {
  let v = AVURLAsset(url: URL(fileURLWithPath: videoPath))
  let a = AVURLAsset(url: URL(fileURLWithPath: audioPath))
  let comp = AVMutableComposition()
  guard let vt = v.tracks(withMediaType: .video).first, let at = a.tracks(withMediaType: .audio).first else { fail("missing track") }
  let len = v.duration
  let cv = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
  let ca = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
  do {
    try cv.insertTimeRange(CMTimeRange(start: .zero, duration: len), of: vt, at: .zero)
    let alen = CMTimeMinimum(len, a.duration)
    try ca.insertTimeRange(CMTimeRange(start: .zero, duration: alen), of: at, at: .zero)
  } catch { fail("insert: \(error)") }
  let url = URL(fileURLWithPath: out)
  try? FileManager.default.removeItem(at: url)
  guard let ex = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetPassthrough) else { fail("no export session") }
  ex.outputURL = url
  ex.outputFileType = .mp4
  ex.shouldOptimizeForNetworkUse = true
  let done = DispatchSemaphore(value: 0)
  ex.exportAsynchronously { done.signal() }
  done.wait()
  if ex.status != .completed { fail("export: \(ex.error?.localizedDescription ?? "?")") }
  print("muxed -> \(out)")
}

func probe(_ path: String) {
  let a = AVURLAsset(url: URL(fileURLWithPath: path))
  let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? 0
  print(String(format: "file      %@ (%.1f MB)", path, Double(size) / 1e6))
  print(String(format: "duration  %.3f s", CMTimeGetSeconds(a.duration)))
  for t in a.tracks {
    let fmt = (t.formatDescriptions.first as! CMFormatDescription)
    let sub = CMFormatDescriptionGetMediaSubType(fmt)
    let cc = String(bytes: [UInt8((sub >> 24) & 255), UInt8((sub >> 16) & 255), UInt8((sub >> 8) & 255), UInt8(sub & 255)], encoding: .ascii) ?? "?"
    if t.mediaType == .video {
      print(String(format: "video     %@ %.0fx%.0f @ %.3f fps, %.1f Mbit/s", cc, t.naturalSize.width, t.naturalSize.height, t.nominalFrameRate, t.estimatedDataRate / 1e6))
    } else {
      let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt)?.pointee
      print(String(format: "audio     %@ %.0f Hz, %d ch, %.0f kbit/s", cc, asbd?.mSampleRate ?? 0, asbd?.mChannelsPerFrame ?? 0, t.estimatedDataRate / 1e3))
    }
  }
}

func frames(_ path: String, _ dir: String, _ times: [Double]) {
  let a = AVURLAsset(url: URL(fileURLWithPath: path))
  let gen = AVAssetImageGenerator(asset: a)
  gen.requestedTimeToleranceBefore = .zero
  gen.requestedTimeToleranceAfter = .zero
  try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
  for t in times {
    guard let img = try? gen.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600), actualTime: nil) else { print("no frame at \(t)"); continue }
    let url = URL(fileURLWithPath: dir).appendingPathComponent(String(format: "%06.2f.png", t))
    guard let dst = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else { continue }
    CGImageDestinationAddImage(dst, img, nil)
    CGImageDestinationFinalize(dst)
    print(url.path)
  }
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: encode video|mux ...") }
switch args[1] {
case "video" where args.count == 7:
  video(out: args[2], w: Int(args[3])!, h: Int(args[4])!, fps: Int32(args[5])!, bitrate: Int(args[6])!)
case "mux" where args.count == 5:
  mux(videoPath: args[2], audioPath: args[3], out: args[4])
case "probe" where args.count == 3:
  probe(args[2])
case "frames" where args.count == 5:
  frames(args[2], args[3], args[4].split(separator: ",").compactMap { Double($0) })
default:
  fail("usage: encode video <out.mp4> <w> <h> <fps> <bitrate> | encode mux <video.mp4> <audio.m4a> <out.mp4>")
}
