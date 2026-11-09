// Clears the focused terminal's scrollback and resets it, like kitty's
// clear_terminal reset. Opened by a key through `mod.open:clear-pane`.
//
// The reset is written to the terminal's tty as if the running program had
// printed it, so it works over vite or a dev server without sending them any
// input. At a shell prompt, ctrl+l then redraws the prompt.
//
// It does nothing while an agent, editor, pager or other full-screen program
// is in the foreground: the reset would corrupt what they have drawn.
//
// Optional settings are read from herdr-clear-pane/settings.json in
// $XDG_CONFIG_HOME, or in ~/.config when that isn't set.
//
// Linux only: the tty is found through /proc.

import { View, div } from "gpui-kit";
import { focused, terminals, hc, exec, closeOverlay, props, notify, readTextFile, home } from "herdr";

const SHELLS = ["zsh", "bash", "fish"];

// Foreground process names, without a ".basic"-style suffix. Agents are
// detected from Herdr's program table instead, so they aren't listed.
const KEEPS_OWN_SCREEN = new Set([
  "vim", "nvim", "vi", "view", "vimdiff", "nano", "emacs", "hx", "kak", "micro",
  "less", "more", "most", "man", "bat",
  "htop", "btop", "top", "tmux", "screen", "lazygit", "yazi",
]);

const SETTINGS_FILE = "herdr-clear-pane/settings.json";
const TOAST_MODES = ["never", "skipped", "always"];

/**
 * @typedef {"never" | "skipped" | "always"} ToastMode
 * `skipped` toasts only when nothing was cleared; `always` also toasts on success.
 */

/**
 * @typedef {object} Config
 * @property {ToastMode} toast
 * @property {string[]} skip Process names to leave alone, besides the built-in ones.
 */

/**
 * The comparable form of a process name: a ".basic"-style suffix is dropped.
 * @param {string} name
 * @returns {string}
 */
function baseName(name) {
  return name.split(".")[0];
}

/**
 * What `hc get <terminal>` reports, limited to the fields used here.
 * @typedef {object} TerminalInfo
 * @property {number} pid Process id of the terminal's first process.
 * @property {{ name?: string }} [foreground] The program now in the foreground.
 */

/**
 * @param {string} message
 * @returns {void}
 */
function warn(message) {
  notify({ title: "Clear pane", body: message, level: "warning" });
}

/**
 * @returns {Promise<string>} `$XDG_CONFIG_HOME` when it is an absolute path
 *   (the spec says to ignore anything else), otherwise `~/.config`.
 */
async function configHome() {
  const result = await exec("sh", ["-c", 'printf %s "$XDG_CONFIG_HOME"']);
  const xdg = result.stdout.trim();
  return xdg.startsWith("/") ? xdg : `${home()}/.config`;
}

/**
 * Missing file or invalid contents fall back to the defaults. The invalid
 * ones are reported.
 * @returns {Promise<Config>}
 */
async function loadConfig() {
  /** @type {Config} */
  const config = { toast: "never", skip: [] };
  const text = await readTextFile(`${await configHome()}/${SETTINGS_FILE}`);
  if (text === null) return config;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    warn("settings.json is not valid JSON, using defaults.");
    return config;
  }
  const { toast, skip } = parsed ?? {};
  if (toast !== undefined) {
    if (TOAST_MODES.includes(toast)) {
      config.toast = toast;
    } else {
      warn("settings.json: toast is never, skipped or always.");
    }
  }
  if (skip !== undefined) {
    if (Array.isArray(skip) && skip.every((name) => typeof name === "string" && name !== "")) {
      config.skip = skip.map(baseName);
    } else {
      warn("settings.json: skip must be a list of names.");
    }
  }
  return config;
}

/**
 * @param {string} terminal Terminal address, e.g. "t14".
 * @param {TerminalInfo} info
 * @param {string[]} extra Names from the settings, besides `KEEPS_OWN_SCREEN`.
 * @returns {string | null} The program that keeps its own screen, or null.
 */
function keepsOwnScreen(terminal, info, extra) {
  const program = terminals().find((t) => t.address === terminal)?.program;
  if (program?.agent) return program.name ?? "An agent";
  const name = baseName(info.foreground?.name ?? "");
  return KEEPS_OWN_SCREEN.has(name) || extra.includes(name) ? name : null;
}

/**
 * @param {number} pid
 * @returns {Promise<string>} The pty device path, e.g. "/dev/pts/3".
 */
async function ttyOf(pid) {
  const link = await exec("readlink", [`/proc/${pid}/fd/0`]);
  const tty = link.stdout.trim();
  if (link.code !== 0 || !tty.startsWith("/dev/pts/")) {
    throw new Error(`no tty found for pid ${pid}`);
  }
  return tty;
}

/**
 * @param {string} terminal Terminal address, e.g. "t14".
 * @param {Config} config
 * @returns {Promise<string | null>} The program that kept the terminal from
 *   being cleared, or null when it was cleared.
 */
async function clearPane(terminal, config) {
  /** @type {TerminalInfo} */
  const info = JSON.parse((await hc(["get", terminal])).stdout);
  const program = keepsOwnScreen(terminal, info, config.skip);
  if (program) return program;
  const tty = await ttyOf(info.pid);
  await exec("sh", ["-c", "printf '\\033c' > \"$1\"", "sh", tty]);
  if (SHELLS.includes(info.foreground?.name)) {
    await hc(["keys", terminal, "ctrl+l"]);
  }
  return null;
}

/**
 * @param {string | null} keptBy The result of `clearPane`.
 * @param {ToastMode} mode
 * @returns {void}
 */
function announce(keptBy, mode) {
  if (keptBy === null) {
    if (mode === "always") notify({ title: "Pane cleared", level: "success" });
  } else if (mode !== "never") {
    notify({ title: "Pane not cleared", body: `${keptBy} keeps its own screen.`, level: "info" });
  }
}

export default class ClearPane extends View {
  /**
   * @param {import("gpui-shell").Props | undefined} _props
   * @param {import("gpui-kit").AsyncContext} cx
   * @returns {void}
   */
  init(_props, cx) {
    const terminal = focused()?.terminal;
    const overlay = props()?.overlay;
    const done = () => overlay && closeOverlay(overlay);
    if (!terminal) return done();
    cx.spawn(async () => {
      try {
        const config = await loadConfig();
        announce(await clearPane(terminal, config), config.toast);
      } catch (error) {
        notify({ title: "Clear pane failed", body: error instanceof Error ? error.message : String(error), level: "error" });
      } finally {
        done();
      }
    });
  }

  render() {
    return div();
  }
}
