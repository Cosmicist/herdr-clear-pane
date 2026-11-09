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
// Linux only: the tty is found through /proc.

import { View, div } from "gpui-kit";
import { focused, terminals, hc, exec, closeOverlay, props, notify } from "herdr";

const SHELLS = ["zsh", "bash", "fish"];

// Foreground process names, without a ".basic"-style suffix. Agents are
// detected from Herdr's program table instead, so they aren't listed.
const KEEPS_OWN_SCREEN = new Set([
  "vim", "nvim", "vi", "view", "vimdiff", "nano", "emacs", "hx", "kak", "micro",
  "less", "more", "most", "man", "bat",
  "htop", "btop", "top", "tmux", "screen", "lazygit", "yazi",
]);

/**
 * What `hc get <terminal>` reports, limited to the fields used here.
 * @typedef {object} TerminalInfo
 * @property {number} pid Process id of the terminal's first process.
 * @property {{ name?: string }} [foreground] The program now in the foreground.
 */

/**
 * @param {string} terminal Terminal address, e.g. "t14".
 * @param {TerminalInfo} info
 * @returns {boolean}
 */
function keepsOwnScreen(terminal, info) {
  const program = terminals().find((t) => t.address === terminal)?.program;
  const name = (info.foreground?.name ?? "").split(".")[0];
  return Boolean(program?.agent) || KEEPS_OWN_SCREEN.has(name);
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
 * @returns {Promise<void>}
 */
async function clearPane(terminal) {
  /** @type {TerminalInfo} */
  const info = JSON.parse((await hc(["get", terminal])).stdout);
  if (keepsOwnScreen(terminal, info)) return;
  const tty = await ttyOf(info.pid);
  await exec("sh", ["-c", "printf '\\033c' > \"$1\"", "sh", tty]);
  if (SHELLS.includes(info.foreground?.name)) {
    await hc(["keys", terminal, "ctrl+l"]);
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
        await clearPane(terminal);
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
