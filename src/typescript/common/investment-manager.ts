import * as path from 'path';
import { randomUUID } from 'crypto';
import { JsonDocument } from './data-store';

const INVESTMENTS_FILE = path.join(__dirname, '../../../data/investments.json');

export interface InvestmentAccount {
  investment_id: string;
  name: string;
  balance: number;
}

type InvestmentsData = Record<string, InvestmentAccount[]>;

/**
 * data/investments.json, as the current browser session sees it (data-store.ts). Every call reads the
 * data again, because the session can differ from call to call.
 */
export class InvestmentManager {
  private readonly document: JsonDocument<InvestmentsData>;

  constructor(filePath = INVESTMENTS_FILE) {
    this.document = new JsonDocument(filePath);
  }

  private async loadData(): Promise<InvestmentsData> {
    try {
      const parsed = await this.document.load();
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      // invalid JSON: fall through to empty
    }
    return {};
  }

  private async saveData(data: InvestmentsData): Promise<void> {
    await this.document.save(data);
  }

  async listInvestmentAccounts(clientId: string): Promise<InvestmentAccount[]> {
    return (await this.loadData())[clientId] ?? [];
  }

  async addInvestmentAccount(
    clientId: string,
    name: string,
    balance: number,
  ): Promise<InvestmentAccount | null> {
    if (balance < 0) return null;
    const data = await this.loadData();
    if (!data[clientId]) data[clientId] = [];

    const existingIds = new Set(data[clientId].map((a) => a.investment_id));
    let newId = `i-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    while (existingIds.has(newId)) {
      newId = `i-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    }

    const account: InvestmentAccount = { investment_id: newId, name, balance };
    data[clientId].push(account);
    await this.saveData(data);
    return account;
  }

  async deleteInvestmentAccount(clientId: string, investmentId: string): Promise<boolean> {
    const data = await this.loadData();
    if (!data[clientId]) return false;
    const before = data[clientId].length;
    data[clientId] = data[clientId].filter((a) => a.investment_id !== investmentId);
    if (data[clientId].length < before) {
      if (data[clientId].length === 0) delete data[clientId];
      await this.saveData(data);
      return true;
    }
    return false;
  }
}
