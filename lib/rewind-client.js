/** Client helpers embedded into the minified 0.2.2 conversation bundle. */
export function isRewindMarker(event) {
  if (!event || event.type !== "user/message") return false;
  const id = event.data && event.data.id;
  if (typeof id !== "string" || !id.startsWith("rewind-")) return false;
  const op = event.surfaceOp;
  return !!op && op !== "append" && op.op === "replace";
}

export function rewindVisibleEntries(entries) {
  const list = Array.isArray(entries) ? entries : [...entries];
  const hidden = new Set();
  const addRange = (start, end) => {
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start && end - start < 100000) {
      for (let seq = start; seq <= end; seq++) hidden.add(seq);
    }
  };
  for (const entry of list) {
    const event = entry && entry.event;
    if (!isRewindMarker(event)) continue;
    hidden.add(event.seq);
    const op = event.surfaceOp;
    addRange(op.startSeq, op.endSeq);
    for (const row of Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []) {
      if (typeof row === "number") hidden.add(row);
      else if (Array.isArray(row) && row.length === 2) addRange(row[0], row[1]);
    }
    const cutEnd = typeof op.endSeq === "number" ? op.endSeq : event.seq;
    let turnStart = null;
    let turnEnd = null;
    for (const row of list) {
      const ev = row && row.event;
      if (!ev || ev.seq >= event.seq) continue;
      if (ev.type === "turn/start") turnStart = ev.seq;
      if (ev.type === "turn/end" && ev.seq >= cutEnd && turnEnd === null) turnEnd = ev.seq;
    }
    if (turnStart !== null) {
      const last = turnEnd === null ? event.seq : turnEnd;
      for (const row of list) {
        const ev = row && row.event;
        if (ev && ev.seq >= turnStart && ev.seq <= last && ev.type !== "system/message") hidden.add(ev.seq);
      }
    }
  }
  return hidden.size ? list.filter(entry => entry?.event && !hidden.has(entry.event.seq)) : list;
}

export const rewindClientHelperSource = `${isRewindMarker.toString()}\n${rewindVisibleEntries.toString()}\n// [dsh-purge] rewind hides the cut turn\n`;
