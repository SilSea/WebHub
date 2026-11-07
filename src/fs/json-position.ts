/**
 * Index of the first syntax error in `text` (strict JSON), or -1 if it parses.
 * Used to report "line L, column C" without echoing file content (V8's JSON.parse messages
 * quote a snippet of the input, which may contain credentials).
 */
export function jsonErrorIndex(text: string): number {
  let i = 0;
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i] ?? "")) i++;
  };
  const fail = (): never => {
    throw i;
  };
  const lit = (word: string) => {
    if (text.startsWith(word, i)) i += word.length;
    else fail();
  };
  const str = () => {
    i++; // opening quote
    while (i < text.length) {
      const c = text[i] ?? "";
      if (c === '"') {
        i++;
        return;
      }
      if (c < " ") fail();
      if (c === "\\") {
        const e = text[i + 1] ?? "";
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail();
          i += 6;
        } else if ('"\\/bfnrt'.includes(e) && e !== "") i += 2;
        else fail();
      } else i++;
    }
    fail();
  };
  const num = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (m === null) fail();
    else i += m[0].length;
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      ws();
      if (text[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        str();
        ws();
        if (text[i] !== ":") fail();
        i++;
        value();
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "}") {
          i++;
          return;
        } else fail();
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") {
        i++;
        return;
      }
      for (;;) {
        value();
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "]") {
          i++;
          return;
        } else fail();
      }
    }
    if (c === '"') str();
    else if (c === "t") lit("true");
    else if (c === "f") lit("false");
    else if (c === "n") lit("null");
    else num();
  };
  try {
    value();
    ws();
    return i < text.length ? i : -1;
  } catch (pos) {
    // anything else (e.g. stack overflow on very deep nesting): position unknown
    return typeof pos === "number" ? pos : -1;
  }
}

/** "line L, column C" (1-based) of an index in `text`. */
export function lineCol(text: string, index: number): string {
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  return `line ${line}, column ${index - before.lastIndexOf("\n")}`;
}
