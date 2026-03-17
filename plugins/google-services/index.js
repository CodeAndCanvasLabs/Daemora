import { calendar } from "../../src/tools/calendar.js";
import { contacts } from "../../src/tools/contacts.js";
import { googlePlaces } from "../../src/tools/googlePlaces.js";
import toolSchemas from "../../src/tools/schemas.js";

export default {
  id: "google-services",
  name: "Google Services",

  register(api) {
    api.registerTool("calendar", calendar, toolSchemas.calendar?.schema || null,
      "calendar(action, ...) — Google Calendar: list, create, update, delete events");

    api.registerTool("contacts", contacts, toolSchemas.contacts?.schema || null,
      "contacts(action, ...) — Google Contacts: search, list, create contacts");

    api.registerTool("googlePlaces", googlePlaces, toolSchemas.googlePlaces?.schema || null,
      "googlePlaces(query, ...) — Search places, get details, nearby search via Google Places API");

    api.log.info("Registered: calendar, contacts, googlePlaces");
  },
};
