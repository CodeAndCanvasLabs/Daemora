---
name: data-analysis
description: CSV/JSON data processing, transformation, analysis, and visualization
triggers: csv, json, data, analysis, chart, graph, plot, statistics, transform, aggregate, filter, sort, dataset, spreadsheet, excel, pandas, table
---
## Workflow: Load → Explore → Transform → Analyze → Report

1. **Load** — read the data file. Check format, encoding, delimiters.
2. **Explore** — check shape (rows × columns), column names, data types, missing values, sample rows.
3. **Transform** — filter, sort, group, pivot, join as needed. Use shell tools or write a script.
4. **Analyze** — compute statistics, find patterns, answer the question.
5. **Report** — present findings clearly. Tables for data, bullet points for insights.

## Tools
- Small CSV/JSON: `executeCommand` with `jq`, `awk`, `sort`, `uniq -c`, `cut`
- Complex analysis: write a Node.js or Python script, execute it
- Charts: generate with a script, save as image, send via replyWithFile

## Patterns
- Column stats: `cat data.csv | awk -F',' '{print $3}' | sort | uniq -c | sort -rn`
- JSON query: `cat data.json | jq '.items[] | select(.price > 100) | .name'`
- Group by: write a script if shell one-liners get too complex

## Don't
- Don't load entire large files into memory if you can stream/filter
- Don't guess data format — read a sample first
- Don't present raw data dumps — summarize and highlight key findings
