// ==UserScript==
// @name         Kling Omni — Auto Tag Prompt
// @namespace    local.kling.autoattach
// @version      0.4.3
// @description  After pasting a prompt, bind every plain-text @Name token to its Element in the library. Handles aliases like @img1 -> Image1.
// @author       Amey Arora
// @homepage     https://socialdealers.in
// @supportURL   https://github.com/ameyarora/kling-ai-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/ameyarora/kling-ai-scripts/main/kling-omni-auto-tag-prompt.user.js
// @updateURL    https://raw.githubusercontent.com/ameyarora/kling-ai-scripts/main/kling-omni-auto-tag-prompt.user.js
// @match        https://app.klingai.com/*
// @match        https://klingai.com/*
// @match        https://*.klingai.com/*
// @match        https://kling.ai/*
// @match        https://*.kling.ai/*
// @match        https://*.kuaishou.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
/*
 * Kling Omni - Auto Tag Prompt
 * Developed by Amey Arora - https://socialdealers.in
 */

(function () {
  'use strict';

  const CFG = {
    debug: true,
    dryRun: false,           // true = log what it would click, click nothing
    autoOnPaste: true,       // false = only run on Ctrl+Shift+E
    stripLeftover: true,     // remove the typed query text Kling leaves before the chip

    // Which @tokens to look for. Matches @img1, @Image2, @my-el_3 — anything
    // word-ish. If your element names contain spaces, see NAMES_WITH_SPACES below.
    tokenRe: /@([\w-]+)/g,

    // ---- ALIASES -------------------------------------------------------
    // Kling only knows the real element names (Image1, Image2, ...). These
    // rewrite what you typed into what Kling has. Pattern -> replacement,
    // $1 is the captured digits. First match wins; if none match, the token
    // is used as-is. The raw token is always tried as a fallback, so an
    // element genuinely named "img1" still binds correctly.
    aliases: [
      [/^img(\d+)$/i, 'Image$1'],      // @img1   -> Image1
      [/^image(\d+)$/i, 'Image$1'],    // @image1 -> Image1  (fixes casing)
      [/^i(\d+)$/i, 'Image$1'],        // @i1     -> Image1
      [/^ref(\d+)$/i, 'Image$1'],      // @ref1   -> Image1
    ],
    // Exact one-off renames, case-insensitive keys: { hero: 'Image1' }
    aliasMap: {},
    // --------------------------------------------------------------------

    settleAfterPaste: 400,   // ms to let Kling finish rendering the pasted text
    dropdownTimeout: 1800,   // ms to wait for the element popup to appear
    verifyTimeout: 1500,     // ms to wait for the chip to actually appear
    afterClickSettle: 250,
    popupMaxDistance: 500,   // px — popup must be within this of the caret
    maxTokens: 80,           // safety cap on total binds
    maxNoProgress: 3,        // consecutive click-failures before giving up
    maxNoMatch: 5,           // consecutive unknown tokens before giving up
    editorSelector: null,    // set to a CSS selector to override auto-detection
  };

  const log = (...a) => CFG.debug && console.log('%c[kling-attach]', 'color:#4ade80', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden';
  };

  async function waitFor(pred, timeout, step = 60) {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      if (pred()) return true;
      await sleep(step);
    }
    return false;
  }

  /* ---------- alias resolution ---------- */

  function canonical(raw) {
    for (const k of Object.keys(CFG.aliasMap)) {
      if (k.toLowerCase() === raw.toLowerCase()) return CFG.aliasMap[k];
    }
    for (const [re, out] of CFG.aliases) {
      if (re.test(raw)) return raw.replace(re, out);
    }
    return raw;
  }

  // canonical name first, raw token as fallback (dedup preserves order)
  function nameCandidates(raw) {
    return [...new Set([canonical(raw), raw])];
  }

  /* ---------- find the prompt editor ---------- */

  function findEditor() {
    if (CFG.editorSelector) return document.querySelector(CFG.editorSelector);
    const cands = [...document.querySelectorAll('[contenteditable="true"],[contenteditable=""]')]
      .filter(visible);
    if (!cands.length) return null;
    // the prompt box is the one holding the most text
    return cands.sort((a, b) => b.textContent.length - a.textContent.length)[0];
  }

  /* ---------- token scanning ---------- */
  // Once a token is bound it renders as a chip and the literal "@Name" text
  // disappears, so plain-text scanning naturally skips finished ones.

  function textNodes(editor) {
    const out = [];
    const w = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) out.push(n);
    return out;
  }

  function nextToken(editor, failed) {
    let base = 0;
    for (const node of textNodes(editor)) {
      const text = node.nodeValue || '';
      CFG.tokenRe.lastIndex = 0;
      let m;
      while ((m = CFG.tokenRe.exec(text))) {
        const key = m[1] + '@' + (base + m.index);
        if (!failed.has(key)) {
          return {
            node, start: m.index, end: m.index + m[0].length,
            raw: m[1], names: nameCandidates(m[1]), key,
          };
        }
      }
      base += text.length;
    }
    return null;
  }

  /* ---------- editing primitives ---------- */

  function selectRange(editor, node, start, end) {
    editor.focus();
    const r = document.createRange();
    r.setStart(node, start);
    r.setEnd(node, end);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function insertText(str) {
    if (document.execCommand('insertText', false, str)) return true;
    // fallback for editors that only listen to beforeinput
    const t = document.activeElement;
    t.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'insertText', data: str, bubbles: true, cancelable: true,
    }));
    t.dispatchEvent(new InputEvent('input', {
      inputType: 'insertText', data: str, bubbles: true,
    }));
    return false;
  }

  function deleteChars(n) {
    for (let i = 0; i < n; i++) document.execCommand('delete');
  }

  /* ---------- find the popup entry ---------- */
  // The page has "Image1" text in several unrelated places (element strip,
  // result cards). Three filters keep us on the real popup:
  //   1. it must NOT have existed before we typed the "@"
  //   2. it must sit within popupMaxDistance of the caret
  //   3. an element inside a floating/overlay container wins over one that isn't

  function labelMatches(name, editor) {
    const wanted = name.trim().toLowerCase();
    const out = [];
    for (const el of document.querySelectorAll('div,li,span,p,button,a,td')) {
      if (el === editor || editor.contains(el)) continue;
      if (el.childElementCount > 4) continue;
      if ((el.textContent || '').trim().toLowerCase() !== wanted) continue;
      if (!visible(el)) continue;
      out.push(el);
    }
    return out;
  }

  function caretRect(editor) {
    const sel = getSelection();
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r.width || r.height || r.top) return r;
    }
    return editor.getBoundingClientRect();
  }

  function inOverlay(el) {
    let n = el;
    for (let i = 0; i < 8 && n && n !== document.body; i++, n = n.parentElement) {
      const s = getComputedStyle(n);
      if ((s.position === 'fixed' || s.position === 'absolute') && (parseInt(s.zIndex, 10) || 0) > 0) {
        return true;
      }
    }
    return false;
  }

  function pickPopupItem(name, editor, seenBefore) {
    const fresh = labelMatches(name, editor).filter((el) => !seenBefore.has(el));
    if (!fresh.length) return null;
    const c = caretRect(editor);
    const scored = fresh
      .filter((el) => !fresh.some((o) => o !== el && el.contains(o))) // deepest wins
      .map((el) => {
        const r = el.getBoundingClientRect();
        const dx = Math.max(0, r.left - c.right, c.left - r.right);
        const dy = Math.max(0, r.top - c.bottom, c.top - r.bottom);
        return { el, d: Math.hypot(dx, dy), overlay: inOverlay(el) ? 1 : 0 };
      })
      .filter((s) => s.d <= CFG.popupMaxDistance);
    if (!scored.length) return null;
    scored.sort((a, b) => b.overlay - a.overlay || a.d - b.d);
    return scored[0].el;
  }

  function pickAny(names, editor, seenMap) {
    for (const name of names) {
      const el = pickPopupItem(name, editor, seenMap.get(name));
      if (el) return { el, name };
    }
    return null;
  }

  function realClick(el) {
    const r = el.getBoundingClientRect();
    const o = {
      bubbles: true, cancelable: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ctor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, o));
    }
  }

  function pressEscape(editor) {
    for (const type of ['keydown', 'keyup']) {
      editor.dispatchEvent(new KeyboardEvent(type, {
        key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true,
      }));
    }
  }

  /* ---------- chip detection + leftover cleanup ---------- */

  // The chip is whatever element appeared inside the editor during the click.
  function findNewChip(editor, before, name) {
    const fresh = [...editor.querySelectorAll('*')].filter((el) => !before.has(el));
    if (!fresh.length) return null;
    const wanted = name.trim().toLowerCase();
    const named = fresh.filter((el) => (el.textContent || '').trim().toLowerCase() === wanted);
    const pool = named.length ? named : fresh;
    return pool.find((el) => !pool.some((o) => o !== el && o.contains(el))) || null;
  }

  function prevTextNode(editor, el) {
    let last = null;
    for (const n of textNodes(editor)) {
      if (el.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING) last = n;
    }
    return last;
  }

  // Kling inserts the chip but leaves the query text sitting immediately
  // before it. Delete exactly that suffix, longest match first, nothing more.
  function stripLeftover(editor, chip, typed) {
    const prev = prevTextNode(editor, chip);
    if (!prev) return false;
    const v = prev.nodeValue || '';
    const cands = (typed ? ['@' + typed, typed] : []).concat('@');
    for (const cand of cands) {
      if (v.toLowerCase().endsWith(cand.toLowerCase())) {
        selectRange(editor, prev, v.length - cand.length, v.length);
        document.execCommand('delete');
        log('stripped leftover "' + cand + '" before the chip');
        return true;
      }
    }
    return false;
  }

  /* ---------- bind one token ---------- */
  // returns 'ok' | 'nomatch' (element not in the library) | 'fail' (click didn't take)

  async function bind(editor, tok) {
    pressEscape(editor);              // close any popup left over from last round
    await sleep(80);

    // snapshot the decoys already on screen, per candidate name
    const seenMap = new Map(tok.names.map((n) => [n, new Set(labelMatches(n, editor))]));

    // wipe the token and type a bare "@" — the unfiltered popup usually already
    // lists the element, and typing nothing means nothing is left behind
    selectRange(editor, tok.node, tok.start, tok.end);
    document.execCommand('delete');
    await sleep(40);
    insertText('@');

    let hit = null, typed = '';
    await waitFor(() => (hit = pickAny(tok.names, editor, seenMap)), CFG.dropdownTimeout);

    if (!hit) {
      // not in the unfiltered list — type each candidate name to filter it down
      for (const name of tok.names) {
        log('filtering popup by typing "' + name + '"');
        for (const ch of name) { insertText(ch); await sleep(60); }
        typed = name;
        let el = null;
        await waitFor(() => (el = pickPopupItem(name, editor, seenMap.get(name))),
                      CFG.dropdownTimeout);
        if (el) { hit = { el, name }; break; }
        deleteChars(name.length);     // undo this query, try the next candidate
        typed = '';
        await sleep(60);
      }
    }

    const restore = () => {
      // put the original token back so a failure never eats prompt text
      if (typed !== tok.raw) {
        if (typed) deleteChars(typed.length);
        insertText(tok.raw);
      }
      pressEscape(editor);
    };

    if (!hit) {
      log('no library element matches @' + tok.raw + ' (tried: ' + tok.names.join(', ') + ')');
      restore();
      return 'nomatch';
    }

    if (CFG.dryRun) {
      log('DRY RUN — @' + tok.raw + ' -> "' + hit.name + '", would click', hit.el);
      restore();
      return 'nomatch';
    }

    const elsBefore = new Set(editor.querySelectorAll('*'));
    log('@' + tok.raw + ' -> binding as "' + hit.name + '"');
    realClick(hit.el);

    // success = a chip element actually materialised inside the editor
    let chip = null;
    const bound = await waitFor(
      () => (chip = findNewChip(editor, elsBefore, hit.name)), CFG.verifyTimeout);
    if (!bound) {
      log('clicked, but no chip appeared - treating as failed');
      restore();
      return 'fail';
    }

    if (CFG.stripLeftover) stripLeftover(editor, chip, typed);
    await sleep(CFG.afterClickSettle);
    return 'ok';
  }

  /* ---------- main loop ---------- */

  let running = false;
  let abort = false;

  async function run() {
    if (running) return;
    const editor = findEditor();
    if (!editor) { log('no contenteditable prompt box found'); return; }
    running = true;
    abort = false;
    const failed = new Set();
    let ok = 0, skipped = 0, noProgress = 0, noMatch = 0;
    try {
      for (let i = 0; i < CFG.maxTokens; i++) {
        if (abort) { log('aborted by user'); break; }
        const tok = nextToken(editor, failed);
        if (!tok) break;
        status('attaching @' + tok.raw + '... (click to stop)');
        const res = await bind(editor, tok);
        if (res === 'ok') {
          ok++;
          noProgress = noMatch = 0;
        } else {
          skipped++;
          failed.add(tok.key);
          if (res === 'fail' && ++noProgress >= CFG.maxNoProgress) {
            log('stopping: ' + noProgress + ' click-failures in a row');
            break;
          }
          if (res === 'nomatch' && ++noMatch >= CFG.maxNoMatch) {
            log('stopping: ' + noMatch + ' unknown tokens in a row');
            break;
          }
        }
      }
    } finally {
      running = false;
      status(skipped ? 'attached ' + ok + ', skipped ' + skipped
                     : 'attached ' + ok + ' element' + (ok === 1 ? '' : 's'), 3000);
      log('done - attached', ok, 'skipped', skipped);
    }
  }

  /* ---------- status pill (click to stop) ---------- */

  let pill, pillTimer;
  function status(msg, hideAfter) {
    if (!pill) {
      pill = document.createElement('div');
      Object.assign(pill.style, {
        position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483647,
        padding: '7px 12px', borderRadius: '8px', font: '12px/1.4 system-ui,sans-serif',
        background: 'rgba(20,20,24,.92)', color: '#4ade80', border: '1px solid #333',
        cursor: 'pointer', transition: 'opacity .2s',
      });
      pill.addEventListener('click', () => { abort = true; status('stopping...', 1500); });
      document.body.appendChild(pill);
    }
    pill.textContent = 'kling-attach: ' + msg;
    pill.style.opacity = '1';
    clearTimeout(pillTimer);
    if (hideAfter) pillTimer = setTimeout(() => { pill.style.opacity = '0'; }, hideAfter);
  }

  /* ---------- triggers ---------- */

  document.addEventListener('paste', (e) => {
    if (!CFG.autoOnPaste) return;
    const editor = findEditor();
    if (!editor) return;
    const t = e.target;
    if (!(t instanceof Node) || (!editor.contains(t) && t !== editor)) return;
    setTimeout(run, CFG.settleAfterPaste);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;                       // ignore our own synthetic Escape
    if (e.key === 'Escape' && running) { abort = true; return; }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); run(); }
  }, true);

  /* ---------- console API ---------- */

  window.klingAttach = {
    CFG, run, canonical,
    stop() { abort = true; },
    diagnose() {
      const editor = findEditor();
      console.log('editor:', editor);
      console.log('editor text:', editor && editor.textContent.slice(0, 400));
      const found = [];
      if (editor) {
        for (const n of textNodes(editor)) {
          CFG.tokenRe.lastIndex = 0;
          let m;
          while ((m = CFG.tokenRe.exec(n.nodeValue || ''))) found.push(m[1]);
        }
      }
      console.table(found.map((raw) => ({ token: '@' + raw, willBindAs: canonical(raw) })));
      if (editor && found.length) {
        console.log('decoys on screen for "' + canonical(found[0]) + '":',
                    labelMatches(canonical(found[0]), editor));
      }
      return { editor, tokens: found };
    },
  };

  console.log('%c[kling-attach] %cby Amey Arora - https://socialdealers.in',
              'color:#4ade80', 'color:#888');
  log('ready - paste a prompt, or press Ctrl+Shift+E. Esc or click the pill to stop.');

  // NAMES_WITH_SPACES: if your elements are named like "Auction Hall", change tokenRe to
  //   /@([A-Za-z0-9][\w -]*?)(?=[\s,.;:!?)\]}"']|$)/g
  // and note it can greedily grab following words in some sentences.
})();
