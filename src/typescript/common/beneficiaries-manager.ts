import * as path from 'path';
import { randomUUID } from 'crypto';
import { JsonDocument } from './data-store';

const BENEFICIARIES_FILE = path.join(__dirname, '../../../data/beneficiaries.json');

export interface Beneficiary {
  beneficiary_id: string;
  first_name: string;
  last_name: string;
  relationship: string;
}

type BeneficiariesData = Record<string, Beneficiary[]>;

/**
 * data/beneficiaries.json, as the current browser session sees it (data-store.ts). Every call reads
 * the data again, because the session can differ from call to call.
 */
export class BeneficiariesManager {
  private readonly document: JsonDocument<BeneficiariesData>;

  constructor(filePath = BENEFICIARIES_FILE) {
    this.document = new JsonDocument(filePath);
  }

  private async loadData(): Promise<BeneficiariesData> {
    try {
      const parsed = await this.document.load();
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      // invalid JSON: fall through to empty
    }
    return {};
  }

  private async saveData(data: BeneficiariesData): Promise<void> {
    await this.document.save(data);
  }

  async listBeneficiaries(clientId: string): Promise<Beneficiary[]> {
    return (await this.loadData())[clientId] ?? [];
  }

  async addBeneficiary(
    clientId: string,
    firstName: string,
    lastName: string,
    relationship: string,
  ): Promise<Beneficiary> {
    const data = await this.loadData();
    if (!data[clientId]) data[clientId] = [];

    const existingIds = new Set(data[clientId].map((b) => b.beneficiary_id));
    let newId = `b-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    while (existingIds.has(newId)) {
      newId = `b-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    }

    const beneficiary: Beneficiary = {
      beneficiary_id: newId,
      first_name: firstName,
      last_name: lastName,
      relationship,
    };
    data[clientId].push(beneficiary);
    await this.saveData(data);
    return beneficiary;
  }

  async deleteBeneficiary(clientId: string, beneficiaryId: string): Promise<boolean> {
    const data = await this.loadData();
    if (!data[clientId]) return false;
    const before = data[clientId].length;
    data[clientId] = data[clientId].filter((b) => b.beneficiary_id !== beneficiaryId);
    if (data[clientId].length < before) {
      if (data[clientId].length === 0) delete data[clientId];
      await this.saveData(data);
      return true;
    }
    return false;
  }
}
