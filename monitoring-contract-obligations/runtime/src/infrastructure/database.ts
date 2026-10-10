import { Pool, types } from 'pg';

// PostgreSQL DATE is a calendar value, not a timestamp. Keep it as YYYY-MM-DD
// so timezone conversion cannot shift a contractual deadline to the previous day.
types.setTypeParser(1082, (value) => value);

export function createDatabasePool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 5_000,
    application_name: 'monitoring-contract-obligations',
  });
}
