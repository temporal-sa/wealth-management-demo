import * as fs from 'fs';
import * as path from 'path';
import { WealthManagementClient } from './shared';

const CLIENTS_FILE = path.join(__dirname, '../../../data/clients.json');

type ClientsData = Record<string, Omit<WealthManagementClient, 'client_id'>>;

export class ClientsManager {
  private filePath: string;
  private data: ClientsData;

  constructor(filePath = CLIENTS_FILE) {
    this.filePath = filePath;
    this.data = this.loadData();
  }

  private loadData(): ClientsData {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) return parsed;
      } catch {
        // fall through
      }
    }
    return {};
  }

  private saveData(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  // The shared data/clients.json keys each client by ID without repeating it in the record, so
  // the ID is added here.
  getClient(clientId: string): WealthManagementClient | null {
    const client = this.data[clientId];
    return client ? { ...client, client_id: clientId } : null;
  }

  addClient(client: WealthManagementClient): WealthManagementClient {
    const { client_id: clientId, ...record } = client;
    this.data[clientId] = record;
    this.saveData();
    return client;
  }

  updateClient(clientId: string, fields: Partial<WealthManagementClient>): WealthManagementClient | null {
    if (!this.data[clientId]) return null;
    const { client_id: _id, ...changes } = fields;
    this.data[clientId] = { ...this.data[clientId], ...changes };
    this.saveData();
    return this.getClient(clientId);
  }
}
