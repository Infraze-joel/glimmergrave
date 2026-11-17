/** Structured one-line JSON logs. Never pass secrets (tokens) or raw client text; names are pre-sanitised. */
export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;
export type Logger = (level: LogLevel, event: string, fields?: LogFields) => void;

export const consoleLogger: Logger = (level, event, fields = {}) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), lvl: level, evt: event, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
};

export const silentLogger: Logger = () => undefined;
