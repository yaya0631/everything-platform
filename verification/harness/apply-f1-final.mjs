import fs from 'node:fs';
let t = fs.readFileSync('REPORT.md', 'utf8');
const rep = (a, b) => { if (!t.includes(a)) { console.log('MISS:', a.slice(0, 60)); return; } t = t.replace(a, b); };

rep(
  `1. **Every AI feature that isn't plain chat is missing.** Photo-studio "Generate image", documents "read aloud" and image generation, audio-studio's TTS voices, video-studio's transcribe/voiceover/AI-video, contracts/expense OCR: all error out with "not available on this server — install the engine". There is no engine to install; the button is a dead end. You would notice within the first hour.`,
  `1. **Every AI feature that isn't plain chat is missing.** Photo-studio "Generate image", audio-studio's TTS voices, video-studio's transcribe/voiceover/AI-video, contracts/expense OCR: all error out with "not available on this server — install the engine" (and documents goes further — its "Generate with AI…" menu item silently disappears). There is no engine to install; the buttons are dead ends. Documents' Read Aloud still works via the browser's built-in speech. You would notice within the first hour.`
);
rep(
  `8. **Small rough edges:**`,
  `8. **The office suite mostly works** (verified end-to-end: spreadsheet formulas/autosave/reopen/.xlsx export, documents typing/autosave/.docx export, presentation slides/reopen, pdf annotate/export) — but pdf's "Save to Puter" fails on every re-save with a server error (a one-line bug), losing the annotation.`
);
const smallEdges = `9. **Small rough edges:**`;
if (t.includes(smallEdges)) {
  // renumber the old item 8 body that followed: it was attached to "Small rough edges:" — reattach as item 9
}
rep(
  `What you would NOT notice (genuinely good): all 51 apps load fast and render pixel-faithfully with zero external traffic; create/edit/save/reload works in the CRUD apps tested (invoicing, POS, contacts, calendar, tasks…);`,
  `What you would NOT notice (genuinely good): all 51 apps load fast and render pixel-faithfully with zero external traffic; create/edit/save/reload works in the CRUD apps tested (invoicing, POS, contacts, calendar, tasks…) and in the office suite (spreadsheet, documents, presentation);`
);
rep(
  `spreadsheet formulas (DOM-grid targeting not completed), documents autosave reopen (marker check inconclusive — reload opens a new untitled doc), presentation slide add, pdf tool flows,`,
  `pdf reopen-with-annotation (blocked by the M13 save failure),`
);
const j = JSON.parse(fs.readFileSync('findings.json', 'utf8'));
const c = {}; for (const f of j.findings) c[f.severity] = (c[f.severity] || 0) + 1;
t = t.replace(/See `findings\.json` \(machine-readable, \d+ findings\)\. Counts: [^.]+\./,
  `See \`findings.json\` (machine-readable, ${j.findings.length} findings; m6 retracted after the f1 agent's completed runs disproved it). Counts: ${JSON.stringify(c).replace(/"/g, '')}.`);
rep(
  `9. **m6 — Save/reopen round-trips** in spreadsheet/presentation (open-list and reload-target bugs) — small, very visible to users.`,
  `9. **m6 (RETRACTED)** — the spreadsheet/presentation reopen concerns were probe artifacts; the completed f1 runs verified both round-trips end-to-end. No fix needed.`
);
fs.writeFileSync('REPORT.md', t);
console.log('counts:', JSON.stringify(c));
