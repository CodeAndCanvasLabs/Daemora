import { calendar } from "./tools/calendar.js";
import { contacts } from "./tools/contacts.js";
import { googlePlaces } from "./tools/googlePlaces.js";

export default {
  id: "google-services",
  name: "Google Services",

  register(api) {
    api.registerTool("calendar", calendar, null,
      "calendar(action, ...) — Google Calendar: list, create, update, delete events");

    api.registerTool("contacts", contacts, null,
      "contacts(action, ...) — Google Contacts: search, list, create contacts");

    api.registerTool("googlePlaces", googlePlaces, null,
      "googlePlaces(query, ...) — Search places, get details, nearby search via Google Places API");

    api.log.info("Registered: calendar, contacts, googlePlaces");
  },
};
