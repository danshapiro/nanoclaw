declare module '@onecli-sh/sdk' {
  export interface OneCLIOptions {
    apiKey?: string;
    timeout?: number;
    url?: string;
  }

  export interface EnsureAgentOptions {
    name: string;
    identifier: string;
  }

  export interface EnsureAgentResult {
    created: boolean;
  }

  export interface ApplyContainerConfigOptions {
    addHostMapping?: boolean;
    agent?: string;
  }

  export class OneCLI {
    constructor(options?: OneCLIOptions);
    ensureAgent(options: EnsureAgentOptions): Promise<EnsureAgentResult>;
    applyContainerConfig(
      args: string[],
      options?: ApplyContainerConfigOptions,
    ): Promise<boolean>;
  }
}
