declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionCommandContext {
    mode: "tui" | "rpc" | "json" | "print";
    ui: {
      select(title: string, options: string[]): Promise<string | undefined>;
      input(title: string, placeholder?: string): Promise<string | undefined>;
      notify(message: string, level: "info" | "warning" | "error"): void;
    };
  }

  export interface ExtensionAPI {
    on(event: string, handler: (...args: any[]) => void): void;
    events: {
      on(name: string, handler: (value: unknown) => void): void;
      emit(name: string, value: unknown): void;
    };
    registerCommand(
      name: string,
      options: {
        description: string;
        handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
      },
    ): void;
  }
}
