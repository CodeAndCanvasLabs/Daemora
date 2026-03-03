---
name: trello
description: Manage Trello boards, lists, and cards via the Trello REST API. Use when the user asks to create a Trello card, move a card, list boards, add a checklist, or automate Trello workflows. Requires TRELLO_API_KEY and TRELLO_TOKEN.
triggers: trello, kanban, trello card, trello board, create card, move card, trello list, trello checklist, trello archive, trello label
metadata: {"daemora": {"emoji": "📋"}}
---

## Setup

Get API key: https://trello.com/app-key (then generate token from that page)

```bash
export TRELLO_API_KEY="your_api_key"
export TRELLO_TOKEN="your_token"

# Quick test: list boards
curl -s "https://api.trello.com/1/members/me/boards?fields=name,id&key=$TRELLO_API_KEY&token=$TRELLO_TOKEN" \
  | python3 -c "import sys,json; [print(b['name'], '→', b['id']) for b in json.load(sys.stdin)]"
```

## Key API endpoints

Base: `https://api.trello.com/1` - always append `key=$TRELLO_API_KEY&token=$TRELLO_TOKEN`

| Operation | Method | Endpoint |
|-----------|--------|----------|
| List boards | GET | `/members/me/boards?fields=name,id` |
| Lists on board | GET | `/boards/{id}/lists?filter=open` |
| Cards on board | GET | `/boards/{id}/cards?fields=name,idList,due` |
| Cards in list | GET | `/lists/{id}/cards` |
| Create card | POST | `/cards` |
| Move card | PUT | `/cards/{id}` with `idList` param |
| Archive card | PUT | `/cards/{id}` with `closed=true` |
| Add comment | POST | `/cards/{id}/actions/comments` |
| Add checklist | POST | `/checklists` with `idCard` param |

## Create card example

```bash
curl -s -X POST "https://api.trello.com/1/cards" \
  -d "key=$TRELLO_API_KEY&token=$TRELLO_TOKEN" \
  -d "idList=LIST_ID&name=Task+title&desc=Description&due=2026-03-15T09:00:00.000Z&pos=top"
```

## Move card example

```bash
curl -s -X PUT "https://api.trello.com/1/cards/CARD_ID" \
  -d "key=$TRELLO_API_KEY&token=$TRELLO_TOKEN&idList=TARGET_LIST_ID"
```

## Errors

| Error | Fix |
|-------|-----|
| 401 Unauthorized | Check `TRELLO_API_KEY` and `TRELLO_TOKEN` are valid |
| 404 Not Found | Board/list/card ID is wrong - list boards/lists first to get correct IDs |
| 429 Rate Limited | Add 100ms delay between bulk calls |
