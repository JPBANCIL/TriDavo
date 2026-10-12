const { AsyncLocalStorage } = require('async_hooks');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL must be configured.');

const pool = new Pool({ connectionString, max: 1 });
const transactionContext = new AsyncLocalStorage();
let initialization;

function postgresPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function query(sql, parameters = []) {
  const client = transactionContext.getStore() || pool;
  return client.query(postgresPlaceholders(sql), parameters);
}

const database = {
  pool,
  initialize() {
    if (!initialization) {
      const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      initialization = pool.query(schema);
    }
    return initialization;
  },
  prepare(sql) {
    return {
      get: async (...parameters) => (await query(sql, parameters)).rows[0],
      all: async (...parameters) => (await query(sql, parameters)).rows,
      run: async (...parameters) => {
        const statement = /^\s*INSERT\b/i.test(sql) && !/\bRETURNING\b/i.test(sql)
          ? `${sql} RETURNING id`
          : sql;
        const result = await query(statement, parameters);
        return { changes: result.rowCount, lastInsertRowid: result.rows[0]?.id };
      }
    };
  },
  exec(sql) {
    return query(sql);
  },
  transaction(callback) {
    return (...parameters) => this.runTransaction(callback, parameters);
  },
  async runTransaction(callback, parameters) {
    const activeClient = transactionContext.getStore();
    if (activeClient) {
      const savepoint = `tridavo_${Math.random().toString(36).slice(2)}`;
      await activeClient.query(`SAVEPOINT ${savepoint}`);
      try {
        const result = await transactionContext.run(activeClient, () => callback(...parameters));
        await activeClient.query(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        await activeClient.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        throw error;
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await transactionContext.run(client, () => callback(...parameters));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
};

module.exports = database;
