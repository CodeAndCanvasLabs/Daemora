import { database } from "../../src/tools/database.js";
import toolSchemas from "../../src/tools/schemas.js";

export default {
  id: "database-connector",
  name: "Database Connector",

  register(api) {
    api.registerTool("database", database, toolSchemas.database?.schema || null,
      "database(action, ...) — Query PostgreSQL, MySQL, SQLite databases. Run SQL, list tables, describe schema");

    api.log.info("Registered: database");
  },
};
