// main.js
// Stability + bug‑fix layer for existing public.index.html
// DOES NOT alter layout or markup

(function () {
  'use strict';

  // ❗ Guard: only patch once
  if (window.__SUPERAGENT_PATCHED__) return;
  window.__SUPERAGENT_PATCHED__ = true;

  /* ===============================
     CHAT BUG FIXES
     =============================== */

  // Preserve original sendMsg
  const _sendMsg = window.sendMsg;

  if (typeof _sendMsg === 'function') {
    window.sendMsg = async function () {
      if (window.BUSY) return;

      const inp = document.getElementById('chatIn');
      if (!inp) return;

      const text = inp.value.trim();
      if (!text) return;

      inp.value = '';
      inp.style.height = '';

      // USER bubble (unchanged)
      addBubble('me', renderMd(text), Date.now());
      hist.push({ role: 'user', content: text });
      lw(HK, hist);

      passiveExtract(text);

      // doc triggers
      if (Array.isArray(DOC_TRIG)) {
        DOC_TRIG.forEach(t => {
          if (t.q.test(text)) {
            setTimeout(() => showDoc(t.doc), 400);
          }
        });
      }

      // ✅ STREAM SAFELY
      try {
        await streamResp(text);
      } catch (err) {
        console.error('[sendMsg]', err);
        addBubble('assistant', '⚠️ Error sending message.', Date.now());
        BUSY = false;
        setAiStatus('SuperAgent ready');
      }
    };
  }

  /* ===============================
     STREAM FINALIZATION FIX
     =============================== */

  const _callStream = window.callStream;

  if (typeof _callStream === 'function') {
    window.callStream = async function (
      messages,
      onChunk,
      onDone,
      onErr
    ) {
      let finalized = false;

      return _callStream(
        messages,

        // ✅ chunk handler unchanged
        onChunk,

        // ✅ done handler
        function (full) {
          if (!finalized) {
            finalized = true;
            onDone(full);
          }
        },

        // ✅ ERROR HANDLER – THIS IS THE IMPORTANT PART
        function (err) {
          if (finalized) return;
          finalized = true;

          // Defensive: surface real error text if it was JSON parse related
          const message =
            typeof err === 'string'
              ? err
              : err?.message || 'Unknown server error';

          console.error('[callStream:error]', err);

          onErr(message);
        }
      );
    };
  }

  /* ===============================
     SAFETY: ALWAYS FINALIZE BUSY
     =============================== */

  const _streamResp = window.streamResp;

  if (typeof _streamResp === 'function') {
    window.streamResp = async function (text) {
      try {
        await _streamResp(text);
      } catch (e) {
        console.error('[streamResp]', e);

        const message =
          typeof e === 'string'
            ? e
            : e?.message || 'Server error';

        addBubble('assistant', `⚠️ ${message}`, Date.now());
      } finally {
        window.BUSY = false;
        setAiStatus((id?.name || 'SuperAgent') + ' ready');
      }
    };
  }

  /* ===============================
     INIT CANVAS (p5.js)
     =============================== */

  if (window.createCanvas) {
    try {
      // p5 auto‑starts on load
      console.info('[canvas] p5 initialized');
    } catch (e) {
      console.warn('[canvas]', e);
    }
  }

  console.info('✅ SuperAgent frontend stabilized');
})();