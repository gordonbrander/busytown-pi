export class ExitError extends Error {
  code: number;

  constructor(message: string, code: number = 0) {
    super(message);
    this.name = "AgentKilledError";
    this.code = code;
  }

  toString(): string {
    return `${this.name}: ${this.message} (code: ${this.code})`;
  }

  toJSON(): object {
    return {
      type: "error",
      name: this.name,
      message: this.message,
      code: this.code,
    };
  }
}
