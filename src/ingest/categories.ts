/*
 * Tool name -> ToolCategory for every agent. Exact names first (the
 * tools each agent actually ships, as seen in real transcripts), then a few
 * word-based fallbacks so a tool added next month still lands on a sensible
 * animation instead of "other".
 */
import type { ToolCategory } from "../shared/events.ts";

const EXACT: Record<string, ToolCategory> = {};
const add = (cat: ToolCategory, names: string) => {
  for (const n of names.split(/\s+/)) if (n) EXACT[n] = cat;
};

add("read", `
  read notebookread read_file readfile read_multiple_files read_many_files view_image view
  open_file cat get_command_code_knowledge listmcpresourcestool readmcpresourcetool
  readlints read_lints get_diagnostics list_mcp_resources list_mcp_resource_templates read_mcp_resource
  pty_read
`);
add("edit", `
  edit write multiedit notebookedit apply_patch write_file edit_file create_file str_replace
  str_replace_editor str_replace_based_edit_tool insert delete_file move_file rename_file
  create strreplace applypatch replace patch delete editnotebook edit_notebook multi_edit
`);
add("bash", `
  bash shell exec_command run_command shell_command local_shell local_shell_call write_stdin
  bash_output bashoutput killshell kill_shell taskstop taskoutput monitor monitor_command
  monitor_events shell_tasks exec wait execute run_shell_command shell_exec pty_spawn pty_write
  pty_kill pty_list await aside_repl
`);
add("search", `
  grep glob search find ls list read_directory read_dir list_directory list_dir list_files
  codebase_search search_files file_search toolsearch lsp semanticsearch semantic_search codesearch
  search_file_content grep_search
`);
add("web", `
  webfetch websearch web_fetch web_search web_search_call fetch web__run web_run browser
  web_browser fetchurl fetch_url google_web_search
`);
add("agent", `
  task agent explore spawn_agent wait_agent send_message sendmessage followup_task list_agents
  interrupt_agent close_agent workflow subagenthandback agent_output codebase_investigator
  delegate_to_agent
`);
add("todo", `
  todowrite todoread todo_write todo_read update_plan exitplanmode enterplanmode exit_plan_mode
  enter_plan_mode taskcreate taskupdate tasklist taskget task_create task_update task_list
  task_get get_goal update_goal create_goal write_todos updatecurrentstep exitspecmode plan_enter
  plan_exit
`);

export function categorize(name: string | undefined): ToolCategory {
  if (!name) return "other";
  const n = name.trim().toLowerCase();
  if (n.startsWith("mcp__") || n.startsWith("mcp_")) return "mcp";
  const exact = EXACT[n];
  if (exact) return exact;
  if (/(^|_)(web|browser|fetch|http|url)(_|$)/.test(n)) return "web";
  if (/(^|_)(grep|glob|search|find|list_dir|ls)(_|$)/.test(n)) return "search";
  if (/(^|_)(read|view|cat)(_|$)/.test(n)) return "read";
  if (/(^|_)(write|edit|patch|replace|create_file)(_|$)/.test(n)) return "edit";
  if (/(^|_)(shell|bash|exec|command|terminal|run)(_|$)/.test(n)) return "bash";
  if (/(^|_)(todo|plan|goal)(_|$)/.test(n)) return "todo";
  if (/(^|_)(agent|subagent|delegate)(_|$)/.test(n)) return "agent";
  return "other";
}
