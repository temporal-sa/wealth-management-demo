// No imports: safe to use in workflow code (data-store.ts, which reads Redis and the files, is not).

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
