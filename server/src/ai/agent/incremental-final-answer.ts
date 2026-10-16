/**
 * Extracts only the top-level answer string from the SAME structured response.
 * These fragments are provisional and may be delivered immediately via SSE.
 * The caller reconciles/reset them after final validation or tool decisions.
 * No repair, second generation, reasoning extraction or tool execution occurs.
 */
export class IncrementalFinalAnswer {
  private mode: "start" | "key" | "colon" | "value" | "separator" | "done" =
    "start";
  private key = "";
  private reading: "key" | "value" | undefined;
  private text = "";
  private escaped = false;
  private unicode: string | undefined;
  private nested = 0;
  private primitive = "";
  private keys = new Set<string>();
  private blocked = false;
  private emitted = "";
  private answer = "";

  push(delta: string): string {
    if (this.blocked) return "";
    for (const char of delta) {
      if (this.reading) {
        if (this.unicode !== undefined) {
          if (!/[0-9a-f]/iu.test(char)) {
            this.blocked = true;
            break;
          }
          this.unicode += char;
          if (this.unicode.length === 4) {
            this.append(String.fromCharCode(parseInt(this.unicode, 16)));
            this.unicode = undefined;
          }
        } else if (this.escaped) {
          this.escaped = false;
          if (char === "u") this.unicode = "";
          else {
            const escapes: Record<string, string> = {
              '"': '"',
              "\\": "\\",
              "/": "/",
              b: "\b",
              f: "\f",
              n: "\n",
              r: "\r",
              t: "\t",
            };
            if (!Object.hasOwn(escapes, char)) {
              this.blocked = true;
              break;
            }
            this.append(escapes[char]);
          }
        } else if (char === "\\") this.escaped = true;
        else if (char === '"') {
          if (this.reading === "key") {
            this.key = this.text;
            if (this.keys.has(this.key)) {
              this.blocked = true;
              break;
            }
            this.keys.add(this.key);
            this.mode = "colon";
          } else this.mode = this.nested ? "value" : "separator";
          this.reading = undefined;
        } else if (char < " ") {
          this.blocked = true;
          break;
        } else this.append(char);
        continue;
      }
      if (/\s/u.test(char)) continue;
      if (this.mode === "start") {
        if (char !== "{") {
          this.blocked = true;
          break;
        }
        this.mode = "key";
      } else if (this.mode === "key") {
        if (char === "}") this.mode = "done";
        else if (char === '"') {
          this.reading = "key";
          this.text = "";
        } else {
          this.blocked = true;
          break;
        }
      } else if (this.mode === "colon") {
        if (char !== ":") {
          this.blocked = true;
          break;
        }
        this.mode = "value";
      } else if (this.mode === "value") {
        if (char === '"') {
          this.reading = "value";
          this.text = "";
        } else if (char === "[" || char === "{") this.nested++;
        else if (char === "]" || char === "}") {
          if (this.nested) {
            if (--this.nested === 0) this.mode = "separator";
          } else if (this.primitive) {
            this.mode = "done";
            this.primitive = "";
          } else {
            this.blocked = true;
            break;
          }
        } else if (char === "," && !this.nested) {
          this.mode = "key";
          this.primitive = "";
        } else if (!this.nested) this.primitive += char;
      } else if (this.mode === "separator") {
        if (char === ",") this.mode = "key";
        else if (char === "}") this.mode = "done";
        else {
          this.blocked = true;
          break;
        }
      } else {
        this.blocked = true;
        break;
      }
    }
    if (this.blocked) return "";
    // Keep a high surrogate until the next fragment completes the pair.
    const visible = this.answer.replace(/[\ud800-\udbff]$/u, "");
    const next = visible.slice(this.emitted.length);
    this.emitted = visible;
    return next;
  }

  get validEnd(): boolean {
    return (
      !this.blocked &&
      this.mode === "done" &&
      !this.reading &&
      this.keys.has("answer")
    );
  }

  private append(char: string) {
    this.text += char;
    if (this.reading === "value" && this.key === "answer" && this.nested === 0)
      this.answer += char;
  }
}
