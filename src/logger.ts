import fs from 'node:fs/promises';
import path from 'node:path';

export class Logger {
  private warned = false;

  constructor(private readonly filePath: string) {}

  async log(event: string, data: Record<string, unknown> = {}): Promise<void> {
    const line = JSON.stringify({ time: new Date().toISOString(), event, ...data });
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, `${line}\n`, 'utf8');
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[cc-autoresume] 日志写入失败：${message}\n`);
      }
    }
  }
}
