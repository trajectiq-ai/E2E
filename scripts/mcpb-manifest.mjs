/**
 * MCPB manifest for the Playwright E2E MCP extension.
 *
 * Lives in its own module (no side effects) so `npm run mcpb` and the unit
 * tests share one definition: every historical .mcpb bug — `./`-prefixed
 * entries, missing manifest_version, a relative entry path — was a manifest
 * shape mistake, and this module is where those invariants are pinned.
 */

/**
 * Build the manifest object for a package.json.
 *
 * Required MCPB fields: name, version, description, author, server.
 * `manifest_version` must be declared explicitly (hosts reject a manifest
 * with neither `dxt_version` nor `manifest_version`).
 *
 * @param {{ name: string, version: string, description: string, license?: string }} packageJson
 */
export function buildManifest(packageJson) {
  return {
    manifest_version: '0.4',
    name: packageJson.name,
    display_name: 'Playwright E2E MCP',
    version: packageJson.version,
    description: packageJson.description,
    author: { name: 'trajectiq-ai', url: 'https://github.com/trajectiq-ai' },
    homepage: 'https://github.com/trajectiq-ai/E2E#readme',
    license: packageJson.license ?? 'MIT',
    keywords: ['mcp', 'playwright', 'e2e', 'testing'],
    server: {
      type: 'node',
      entry_point: 'dist/index.js',
      // `${__dirname}` is substituted by the host with the extension's
      // install directory (Anthropic's own init template does the same);
      // a bare relative path dies in the wrong cwd → "Server disconnected".
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/dist/index.js'],
        env: { PW_MCP_PROJECT_ROOT: '${user_config.project_root}' },
      },
    },
    // Install-time prompt: the host asks once for the folder the Playwright
    // tools should treat as the project root and substitutes it into
    // mcp_config.env (MCPB spec: `${user_config.KEY}` in mcp_config).
    // No default on purpose: a prefilled ${HOME} would hand every tool the
    // whole home directory, so the user must pick a project folder.
    user_config: {
      project_root: {
        type: 'directory',
        title: 'Project root',
        description:
          'Folder containing your project and its Playwright tests; every tool resolves paths against it and can read, run and write files inside it. Pick the project folder, not your home directory.',
        required: true,
      },
    },
    compatibility: {
      runtimes: { node: '>=20' },
      platforms: ['darwin', 'win32', 'linux'],
    },
  };
}
