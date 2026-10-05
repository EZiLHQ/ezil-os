interface EditorContainer {
  exec(command: string): Promise<{ exitCode?: number }>;
}

/** Capture before snapshot creation, including explicit and final checkpoints. */
export async function captureEditorState(container: EditorContainer, workspace: string): Promise<void> {
  const quotedWorkspace = "'" + workspace.replace(/'/g, "'\"'\"'") + "'";
  const result = await container.exec(`bash /usr/local/bin/editor-state.sh capture ${quotedWorkspace}`);
  if (result.exitCode !== 0) throw new Error('editor_state_capture_failed');
}
