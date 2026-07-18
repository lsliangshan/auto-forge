export interface AutomationContext {
  log(message: string): void;
}
export declare function run(context: AutomationContext): Promise<void>;
