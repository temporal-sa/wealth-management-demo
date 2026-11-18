/**
 * The demo's system of record: the JSON files in data/ (beneficiaries, clients, investment accounts
 * and the linked bank accounts), shared by the Temporal and standalone versions.
 *
 * Every call reads the file again and every change writes it back, so a `git checkout data/` takes
 * effect without restarting anything. The files are written with 4-space indents, like the
 * reference port, so a demo run changes only the values. DATA_DIR points the store at another
 * folder; the tests use a copy of the demo data so a demo run can't break them.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { formatUsd } from './money';

export { formatUsd };

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

export interface WealthManagementClient {
  first_name: string;
  last_name: string;
  address: string;
  phone: string;
  email: string;
  marital_status: string;
}

export const CLIENT_FIELDS: Array<keyof WealthManagementClient> = [
  'first_name',
  'last_name',
  'address',
  'phone',
  'email',
  'marital_status',
];

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
  return process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
}

function newId(prefix: string, taken: Set<string>): string {
  for (;;) {
    const id = `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    if (!taken.has(id)) return id;
  }
}

export class DataStore {
  constructor(private readonly dir: string = dataDir()) {}

  private read<T>(file: string, empty: T): T {
    const p = path.join(this.dir, file);
    if (!fs.existsSync(p)) return empty;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  }

  /**
   * Writes the file in the style it already has (its indent, and balances written as floats like
   * 1000.0, as the reference port's Python writes them), so a demo run changes only the values.
   */
  private write(file: string, data: unknown): void {
    const p = path.join(this.dir, file);
    const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
    const indent = /\n( +)\S/.exec(existing)?.[1].length ?? 4;
    const text = JSON.stringify(data, null, indent).replace(
      /("(?:balance|amount|balance_after)": -?\d+)(?=[,\n])/g,
      '$1.0',
    );
    fs.writeFileSync(p, existing.endsWith('\n') ? `${text}\n` : text);
  }

  // -------------------------------------------------------------------------
  // Beneficiaries
  // -------------------------------------------------------------------------

  listBeneficiaries(clientId: string): Beneficiary[] {
    return this.read<Record<string, Beneficiary[]>>('beneficiaries.json', {})[clientId] ?? [];
  }

  addBeneficiary(clientId: string, firstName: string, lastName: string, relationship: string): Beneficiary {
    const data = this.read<Record<string, Beneficiary[]>>('beneficiaries.json', {});
    const list = (data[clientId] ??= []);
    const beneficiary: Beneficiary = {
      beneficiary_id: newId('b', new Set(list.map((b) => b.beneficiary_id))),
      first_name: firstName,
      last_name: lastName,
      relationship,
    };
    list.push(beneficiary);
    this.write('beneficiaries.json', data);
    return beneficiary;
  }

  deleteBeneficiary(clientId: string, beneficiaryId: string): boolean {
    const data = this.read<Record<string, Beneficiary[]>>('beneficiaries.json', {});
    const list = data[clientId] ?? [];
    const kept = list.filter((b) => b.beneficiary_id !== beneficiaryId);
    if (kept.length === list.length) return false;
    data[clientId] = kept;
    this.write('beneficiaries.json', data);
    return true;
  }

  // -------------------------------------------------------------------------
  // Investment accounts
  // -------------------------------------------------------------------------

  listInvestments(clientId: string): InvestmentRecord[] {
    return this.read<Record<string, InvestmentRecord[]>>('investments.json', {})[clientId] ?? [];
  }

  addInvestment(account: InvestmentAccount): InvestmentRecord | null {
    if (!(account.balance >= 0)) return null;
    const data = this.read<Record<string, InvestmentRecord[]>>('investments.json', {});
    const list = (data[account.client_id] ??= []);
    const record: InvestmentRecord = {
      investment_id: newId('i', new Set(list.map((a) => a.investment_id))),
      name: account.name,
      balance: account.balance,
    };
    list.push(record);
    this.write('investments.json', data);
    return record;
  }

  deleteInvestment(clientId: string, investmentId: string): boolean {
    const data = this.read<Record<string, InvestmentRecord[]>>('investments.json', {});
    const list = data[clientId] ?? [];
    const kept = list.filter((a) => a.investment_id !== investmentId);
    if (kept.length === list.length) return false;
    data[clientId] = kept;
    this.write('investments.json', data);
    return true;
  }

  // -------------------------------------------------------------------------
  // Clients
  // -------------------------------------------------------------------------

  getClient(clientId: string): WealthManagementClient | null {
    return this.read<Record<string, WealthManagementClient>>('clients.json', {})[clientId] ?? null;
  }

  /** Saves the given fields. Returns the reference port's result message. */
  updateClient(clientId: string, fields: Partial<WealthManagementClient>): string {
    const data = this.read<Record<string, WealthManagementClient>>('clients.json', {});
    if (!data[clientId]) return `Client ${clientId} not found`;
    data[clientId] = { ...data[clientId], ...fields };
    this.write('clients.json', data);
    return 'Client information successfully updated';
  }

  // -------------------------------------------------------------------------
  // Linked bank accounts. Every movement of money carries a caller-supplied transfer ID and is
  // recorded, so applying the same transfer twice (an activity retried after it succeeded) moves
  // the money only once.
  // -------------------------------------------------------------------------

  private funding(): FundingData {
    const data = this.read<Partial<FundingData>>('funding_accounts.json', {});
    return { accounts: data.accounts ?? {}, transfers: data.transfers ?? {} };
  }

  getFundingAccount(clientId: string): FundingAccount {
    const account = this.funding().accounts[clientId];
    if (!account) throw new Error(`No linked bank account for client ${clientId}`);
    return account;
  }

  debit(clientId: string, amount: number, transferId: string): Transfer {
    const data = this.funding();
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

  credit(clientId: string, amount: number, transferId: string): Transfer {
    const data = this.funding();
    const existing = data.transfers[transferId];
    if (existing) return existing;
    return this.apply(data, clientId, amount, transferId);
  }

  private apply(data: FundingData, clientId: string, delta: number, transferId: string): Transfer {
    const account = data.accounts[clientId];
    if (!account) throw new Error(`No linked bank account for client ${clientId}`);
    account.balance = Math.round((account.balance + delta) * 100) / 100;
    const transfer: Transfer = { client_id: clientId, amount: delta, balance_after: account.balance };
    data.transfers[transferId] = transfer;
    this.write('funding_accounts.json', data);
    return transfer;
  }
}
