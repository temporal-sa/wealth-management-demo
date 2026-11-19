/**
 * The demo's system of record: the JSON files in data/ (beneficiaries, clients, investment accounts
 * and the linked bank accounts), shared by the Temporal and standalone versions.
 *
 * Every call reads the data again and every change writes it back, so a `git checkout data/` takes
 * effect without restarting anything. The files are written with 4-space indents, like the reference
 * framework, so a demo run changes only the values. DATA_DIR points the store at another folder; the
 * tests use a copy of the demo data so a demo run can't break them.
 *
 * With DEMO_DATA_STORE=redis each browser session gets its own copy of each file in Redis instead
 * (data:<session>:<file name>), and the files are only read (common/data-store.ts).
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { formatUsd } from './money';
import { WealthManagementClient } from './client-record';
import { JsonDocument } from '../../common/data-store';

export { formatUsd };
export { CLIENT_FIELDS, type WealthManagementClient } from './client-record';

export interface Beneficiary {
  beneficiary_id: string;
  first_name: string;
  last_name: string;
  relationship: string;
}

/** An investment account as stored. */
export interface InvestmentRecord {
  investment_id: string;
  name: string;
  balance: number;
}

/** A new investment account: the open_investment activity's input. */
export interface InvestmentAccount {
  client_id: string;
  name: string;
  balance: number;
}

export interface FundingAccount {
  name: string;
  balance: number;
}

export interface Transfer {
  client_id: string;
  amount: number;
  balance_after: number;
}

interface FundingData {
  accounts: Record<string, FundingAccount>;
  transfers: Record<string, Transfer>;
}

export class InsufficientFundsError extends Error {}

/** The data folder: DATA_DIR, or data/ at the repository root. */
export function dataDir(): string {
  return process.env.DATA_DIR || path.join(__dirname, '..', '..', '..', '..', 'data');
}

function newId(prefix: string, taken: Set<string>): string {
  for (;;) {
    const id = `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    if (!taken.has(id)) return id;
  }
}

export class DataStore {
  constructor(private readonly dir: string = dataDir()) {}

  // The file as the current browser session sees it (the session is looked up on every call)
  private document<T>(file: string): JsonDocument<T> {
    return new JsonDocument<T>(path.join(this.dir, file));
  }

  private async read<T>(file: string, empty: T): Promise<T> {
    return (await this.document<T>(file).load()) ?? empty;
  }

  /**
   * Writes the file in the style it already has (its indent, and balances written as floats like
   * 1000.0, as the reference framework's Python writes them), so a demo run changes only the values.
   */
  private async write(file: string, data: unknown): Promise<void> {
    const p = path.join(this.dir, file);
    await this.document<unknown>(file).save(data, (d) => {
      const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
      const indent = /\n( +)\S/.exec(existing)?.[1].length ?? 4;
      const text = JSON.stringify(d, null, indent).replace(
        /("(?:balance|amount|balance_after)": -?\d+)(?=[,\n])/g,
        '$1.0',
      );
      return existing.endsWith('\n') ? `${text}\n` : text;
    });
  }

  // -------------------------------------------------------------------------
  // Beneficiaries
  // -------------------------------------------------------------------------

  async listBeneficiaries(clientId: string): Promise<Beneficiary[]> {
    return (await this.read<Record<string, Beneficiary[]>>('beneficiaries.json', {}))[clientId] ?? [];
  }

  async addBeneficiary(
    clientId: string,
    firstName: string,
    lastName: string,
    relationship: string,
  ): Promise<Beneficiary> {
    const data = await this.read<Record<string, Beneficiary[]>>('beneficiaries.json', {});
    const list = (data[clientId] ??= []);
    const beneficiary: Beneficiary = {
      beneficiary_id: newId('b', new Set(list.map((b) => b.beneficiary_id))),
      first_name: firstName,
      last_name: lastName,
      relationship,
    };
    list.push(beneficiary);
    await this.write('beneficiaries.json', data);
    return beneficiary;
  }

  async deleteBeneficiary(clientId: string, beneficiaryId: string): Promise<boolean> {
    const data = await this.read<Record<string, Beneficiary[]>>('beneficiaries.json', {});
    const list = data[clientId] ?? [];
    const kept = list.filter((b) => b.beneficiary_id !== beneficiaryId);
    if (kept.length === list.length) return false;
    data[clientId] = kept;
    await this.write('beneficiaries.json', data);
    return true;
  }

  // -------------------------------------------------------------------------
  // Investment accounts
  // -------------------------------------------------------------------------

  async listInvestments(clientId: string): Promise<InvestmentRecord[]> {
    return (await this.read<Record<string, InvestmentRecord[]>>('investments.json', {}))[clientId] ?? [];
  }

  async addInvestment(account: InvestmentAccount): Promise<InvestmentRecord | null> {
    if (!(account.balance >= 0)) return null;
    const data = await this.read<Record<string, InvestmentRecord[]>>('investments.json', {});
    const list = (data[account.client_id] ??= []);
    const record: InvestmentRecord = {
      investment_id: newId('i', new Set(list.map((a) => a.investment_id))),
      name: account.name,
      balance: account.balance,
    };
    list.push(record);
    await this.write('investments.json', data);
    return record;
  }

  async deleteInvestment(clientId: string, investmentId: string): Promise<boolean> {
    const data = await this.read<Record<string, InvestmentRecord[]>>('investments.json', {});
    const list = data[clientId] ?? [];
    const kept = list.filter((a) => a.investment_id !== investmentId);
    if (kept.length === list.length) return false;
    data[clientId] = kept;
    await this.write('investments.json', data);
    return true;
  }

  // -------------------------------------------------------------------------
  // Clients
  // -------------------------------------------------------------------------

  async getClient(clientId: string): Promise<WealthManagementClient | null> {
    return (await this.read<Record<string, WealthManagementClient>>('clients.json', {}))[clientId] ?? null;
  }

  /** Saves the given fields. Returns the reference framework's result message. */
  async updateClient(clientId: string, fields: Partial<WealthManagementClient>): Promise<string> {
    const data = await this.read<Record<string, WealthManagementClient>>('clients.json', {});
    if (!data[clientId]) return `Client ${clientId} not found`;
    data[clientId] = { ...data[clientId], ...fields };
    await this.write('clients.json', data);
    return 'Client information successfully updated';
  }

  // -------------------------------------------------------------------------
  // Linked bank accounts. Every movement of money carries a caller-supplied transfer ID and is
  // recorded, so applying the same transfer twice (an activity retried after it succeeded) moves
  // the money only once.
  // -------------------------------------------------------------------------

  private async funding(): Promise<FundingData> {
    const data = await this.read<Partial<FundingData>>('funding_accounts.json', {});
    return { accounts: data.accounts ?? {}, transfers: data.transfers ?? {} };
  }

  async getFundingAccount(clientId: string): Promise<FundingAccount> {
    const account = (await this.funding()).accounts[clientId];
    if (!account) throw new Error(`No linked bank account for client ${clientId}`);
    return account;
  }

  async debit(clientId: string, amount: number, transferId: string): Promise<Transfer> {
    const data = await this.funding();
    const existing = data.transfers[transferId];
    if (existing) return existing;
    const account = data.accounts[clientId];
    if (!account) throw new Error(`No linked bank account for client ${clientId}`);
    if (account.balance < amount) {
      throw new InsufficientFundsError(
        `${account.name} has ${formatUsd(account.balance)}, which is not enough to transfer ${formatUsd(amount)}`,
      );
    }
    return this.apply(data, clientId, -amount, transferId);
  }

  async credit(clientId: string, amount: number, transferId: string): Promise<Transfer> {
    const data = await this.funding();
    const existing = data.transfers[transferId];
    if (existing) return existing;
    return this.apply(data, clientId, amount, transferId);
  }

  private async apply(data: FundingData, clientId: string, delta: number, transferId: string): Promise<Transfer> {
    const account = data.accounts[clientId];
    if (!account) throw new Error(`No linked bank account for client ${clientId}`);
    account.balance = Math.round((account.balance + delta) * 100) / 100;
    const transfer: Transfer = { client_id: clientId, amount: delta, balance_after: account.balance };
    data.transfers[transferId] = transfer;
    await this.write('funding_accounts.json', data);
    return transfer;
  }
}
