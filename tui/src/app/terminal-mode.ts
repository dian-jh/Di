/**
 * The chat UI always uses the interactive alternate-screen viewport.
 * Keeping terminal selection independent of environment markers ensures that mouse
 * fold controls and the transcript ScrollView work in cmd-launched Windows sessions too.
 */
export function terminalScreenMode(
  _platform: string = process.platform,
  _env: NodeJS.ProcessEnv = process.env,
): "interactive" {
  return "interactive";
}
