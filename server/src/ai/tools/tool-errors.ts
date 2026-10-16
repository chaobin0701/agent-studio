export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRegistryError';
  }
}

export class DuplicateToolError extends ToolRegistryError {
  constructor(name: string) {
    super(`Tool already registered: ${name}`);
    this.name = 'DuplicateToolError';
  }
}

export class UnknownToolError extends ToolRegistryError {
  constructor(name: string) {
    super(`Unknown tool: ${name}`);
    this.name = 'UnknownToolError';
  }
}
