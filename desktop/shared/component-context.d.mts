export type ComponentContext = Readonly<{
  id: 'warehouse' | 'exporter';
  appRoot: string;
  resourcesDir: string;
  version: string;
  launchArgs: readonly string[];
}>;
export function readComponentContext(expectedId: 'warehouse' | 'exporter', env?: NodeJS.ProcessEnv): ComponentContext | null;
