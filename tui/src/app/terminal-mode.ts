/**
 * The chat UI always uses the interactive alternate-screen viewport.
 * Windows mouse reporting must also be restored after raw-input initialization;
 * selecting an alternate screen alone does not guarantee mouse input.
 */
export function terminalScreenMode(
  _platform: string = process.platform,
  _env: NodeJS.ProcessEnv = process.env,
): "interactive" {
  return "interactive";
}

/** Start the screen and keep Windows console mouse reporting enabled. */
export function startInteractiveScreen(
  screen: { start(): void; terminal: { write(data: string): void } },
  platform: string = process.platform,
): void {
  screen.start();
  // pi-tui sends mouse enable sequences before ProcessTerminal.start(), whose
  // Windows raw-mode setup can reset the console input flags. Re-enable button
  // motion and SGR reporting once input setup is complete; screen.stop() handles
  // disabling these modes normally.
  if (platform === "win32") {
    screen.terminal.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
  }
}
