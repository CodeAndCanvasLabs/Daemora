import { database } from "./tools/database.js";

export default {
  id: "database-connector",
  name: "Database Connector",

  register(api) {
    api.registerTool("database", database, null,
      "database(action, ...) — Query PostgreSQL, MySQL, SQLite databases. Run SQL, list tables, describe schema");

    api.log.info("Registered: database");
  },
};
