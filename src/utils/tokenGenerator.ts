/**
 * tokenGenerator.ts — Automated Denuvo token generation
 * 
 * Uses headless_token.py which:
 * 1. Fetches Steam credentials from steampass.gg API
 * 2. Gets Steam Guard code from steampass.gg
 * 3. Connects to Steam CM servers headlessly (no Steam client needed)
 * 4. Generates encrypted app ticket
 * 5. Packages everything into a zip
 * 
 * Falls back to the legacy generate_token.py if no steampass UUID is configured.
 */

import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import prisma from '../lib/prisma';

// Resolve Python — env override, venv, or system python3.
function resolvePython(): string {
  if (process.env.PYTHON_PATH) return process.env.PYTHON_PATH;
  const venvPython = '/app/.venv/bin/python';
  if (fs.existsSync(venvPython)) return venvPython;
  return 'python3';
}
const PYTHON_EXE = resolvePython();

// Where Railpack installed Python deps via `pip install --target=...`.
// Adding to PYTHONPATH lets the system python3 import those packages.
const PYTHON_DEPS_DIR = '/app/python_deps';
const HAS_DEPS_DIR = fs.existsSync(PYTHON_DEPS_DIR);

console.log(`[TokenGen] Using Python: ${PYTHON_EXE}${HAS_DEPS_DIR ? ` (deps: ${PYTHON_DEPS_DIR})` : ''}`);

const HEADLESS_SCRIPT = path.join(__dirname, '..', '..', 'headless_token.py');
const LEGACY_SCRIPT = path.join(__dirname, '..', '..', 'generate_token.py');

function buildPythonEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  if (HAS_DEPS_DIR) {
    env.PYTHONPATH = env.PYTHONPATH
      ? `${PYTHON_DEPS_DIR}:${env.PYTHONPATH}`
      : PYTHON_DEPS_DIR;
  }
  return env;
}

/**
 * Generate a Denuvo token zip for the given AppID.
 * Returns the absolute path to the generated zip file, or null on failure.
 */
export async function generateToken(appId: number, gameName: string): Promise<{ zipPath: string | null; logs: string }> {
  // Look up steampass UUID from the database
  const game = await prisma.game.findFirst({ where: { appId } });
  const steampassUuid = game?.steampassUuid;

  if (steampassUuid) {
    // Use headless generation (no Steam client needed)
    return generateHeadless(appId, gameName, steampassUuid);
  } else {
    // Fallback to legacy local generation (requires Steam client)
    console.log(`[TokenGen] No steampass UUID for AppID ${appId}, falling back to legacy generator`);
    return generateLegacy(appId, gameName);
  }
}

/**
 * Generate a TEST token (fake credentials, no Steam authentication).
 * Used by the /test slash command so staff can verify a game's template
 * ships correctly without consuming a real steampass account.
 *
 * The output zip is labeled "TEST [Game Name].zip" and contains a
 * placeholder ticket. The structure (DLLs, configs, achievements, etc.)
 * is identical to a real token zip — only the ticket value is fake.
 */
export async function generateTestToken(appId: number, gameName: string): Promise<{ zipPath: string | null; logs: string }> {
  return generateHeadless(appId, gameName, 'FAKE');
}

/**
 * Headless token generation via steampass.gg + ValvePython steam library.
 * No Steam client needed — connects directly to Steam CM servers.
 */
function generateHeadless(appId: number, gameName: string, steampassUuid: string): Promise<{ zipPath: string | null; logs: string }> {
  return new Promise((resolve) => {
    const env = buildPythonEnv({
      STEAMPASS_LOGIN: process.env.STEAMPASS_LOGIN || '',
      STEAMPASS_PASSWORD: process.env.STEAMPASS_PASSWORD || '',
    });

    const proc = execFile(
      PYTHON_EXE,
      [HEADLESS_SCRIPT, String(appId), gameName, steampassUuid],
      { timeout: 90000, maxBuffer: 1024 * 1024, env },
      (error, stdout, stderr) => {
        const logs = stdout + (stderr ? `\n${stderr}` : '');

        if (error) {
          console.error(`[TokenGen:Headless] Process error for AppID ${appId}:`, error.message);
          resolve({ zipPath: null, logs });
          return;
        }

        // The script outputs the zip path as the last non-empty line
        const lines = stdout.trim().split('\n').filter(l => l.trim());
        const lastLine = lines[lines.length - 1]?.trim();

        if (lastLine && fs.existsSync(lastLine)) {
          console.log(`[TokenGen:Headless] Success for AppID ${appId}: ${lastLine}`);
          resolve({ zipPath: lastLine, logs });
        } else {
          console.error(`[TokenGen:Headless] No valid zip path found. Output:\n${stdout}`);
          resolve({ zipPath: null, logs });
        }
      }
    );
  });
}

/**
 * Legacy token generation using local Steam client + generate_token.py.
 * Requires Steam to be running and logged into an account that owns the game.
 */
function generateLegacy(appId: number, gameName: string): Promise<{ zipPath: string | null; logs: string }> {
  return new Promise((resolve) => {
    const proc = execFile(
      PYTHON_EXE,
      [LEGACY_SCRIPT, String(appId), gameName],
      { timeout: 60000, maxBuffer: 1024 * 1024, env: buildPythonEnv() },
      (error, stdout, stderr) => {
        const logs = stdout + (stderr ? `\n${stderr}` : '');

        if (error) {
          console.error(`[TokenGen:Legacy] Process error for AppID ${appId}:`, error.message);
          resolve({ zipPath: null, logs });
          return;
        }

        const lines = stdout.trim().split('\n').filter(l => l.trim());
        const lastLine = lines[lines.length - 1]?.trim();

        if (lastLine && fs.existsSync(lastLine)) {
          console.log(`[TokenGen:Legacy] Success for AppID ${appId}: ${lastLine}`);
          resolve({ zipPath: lastLine, logs });
        } else {
          console.error(`[TokenGen:Legacy] No valid zip path found. Output:\n${stdout}`);
          resolve({ zipPath: null, logs });
        }
      }
    );
  });
}
