import sqlite3
import sys

TABLES = (
    'users',
    'program_templates',
    'programs',
    'coach_requests',
    'program_assignments',
    'program_template_workouts',
    'workouts',
)


def sql_value(value):
    if value is None:
        return 'NULL'
    if isinstance(value, (int, float)):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def main():
    database_path = sys.argv[1] if len(sys.argv) > 1 else 'database/tridavo.db'
    connection = sqlite3.connect(database_path)
    print('BEGIN;')

    for table in TABLES:
        columns = [row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')]
        if not columns:
            continue
        column_sql = ', '.join(f'"{column}"' for column in columns)
        rows = connection.execute(f'SELECT {column_sql} FROM "{table}" ORDER BY id')
        for row in rows:
            values = ', '.join(sql_value(value) for value in row)
            print(f'INSERT INTO "{table}" ({column_sql}) VALUES ({values});')

    for table in TABLES:
        print(
            "SELECT setval(pg_get_serial_sequence('"
            + table
            + "', 'id'), GREATEST(COALESCE(MAX(id), 1), 1), COUNT(*) > 0) FROM \""
            + table
            + "\";"
        )

    print('COMMIT;')
    connection.close()


if __name__ == '__main__':
    main()
