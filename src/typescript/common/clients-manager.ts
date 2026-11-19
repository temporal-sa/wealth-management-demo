import * as path from 'path';
import { JsonDocument } from './data-store';
import { WealthManagementClient } from './shared';

const CLIENTS_FILE = path.join(__dirname, '../../../data/clients.json');

type ClientsData = Record<string, Omit<WealthManagementClient, 'client_id'>>;

/**
 * data/clients.json, as the current browser session sees it (data-store.ts). Every call reads the
 * data again, because the session can differ from call to call.
 */
export class ClientsManager {
  private readonly document: JsonDocument<ClientsData>;

  constructor(filePath = CLIENTS_FILE) {
    this.document = new JsonDocument(filePath);
  }

  private async loadData(): Promise<ClientsData> {
    try {
      const parsed = await this.document.load();
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      // invalid JSON: fall through
    }
    return {};
  }

  private async saveData(data: ClientsData): Promise<void> {
    await this.document.save(data);
  }

  // The shared data/clients.json keys each client by ID without repeating it in the record, so
  // the ID is added here.
  async getClient(clientId: string): Promise<WealthManagementClient | null> {
    const client = (await this.loadData())[clientId];
    return client ? { ...client, client_id: clientId } : null;
  }

  async addClient(client: WealthManagementClient): Promise<WealthManagementClient> {
    const { client_id: clientId, ...record } = client;
    const data = await this.loadData();
    data[clientId] = record;
    await this.saveData(data);
    return client;
  }

  async updateClient(
    clientId: string,
    fields: Partial<WealthManagementClient>,
  ): Promise<WealthManagementClient | null> {
    const data = await this.loadData();
    if (!data[clientId]) return null;
    const { client_id: _id, ...changes } = fields;
    data[clientId] = { ...data[clientId], ...changes };
    await this.saveData(data);
    return { ...data[clientId], client_id: clientId };
  }
}
