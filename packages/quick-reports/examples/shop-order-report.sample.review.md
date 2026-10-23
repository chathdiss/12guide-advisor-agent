# Sample Shop Order Report per week (SQL quick report)

Customer Sample Customer, ticket TEST-002, specification A1 (sample).

The labour absorption in a week per work centre: for each closed shop order with labour postings in the week, the actual labour cost from the general ledger, spread over the work centres in proportion to the standard labour cost of the routing operations.

## Parameters

| Parameter | Type | Mandatory | Default | Used in the SQL as |
|---|---|---|---|---|
| Company | string | yes | 100 | `'&Company'` |
| From Date | date | yes | start date of the previous week | `'&FromDate'` |
| To Date | date | yes | end date of the previous week | `'&ToDate'` |

## Columns of the report

| # | Column | Where the specification takes it from | Source in IFS |
|---|---|---|---|
| 1 | Shop Order | Shop Order number of each distinct Shop Order that meets the criteria | `SHOP_ORD.ORDER_NO (with RELEASE_NO and SEQUENCE_NO)` |
| 2 | Status | Status of the Shop Order. This will always be Closed | `SHOP_ORD.STATE` |
| 3 | Completed Qty | The qty completed on each shop order | `SHOP_ORD.QTY_COMPLETE` |
| 4 | Labour Cost (from GL) | Actual labour cost reported for each shop order within the given period | `sum of GEN_LED_VOUCHER_ROW.AMOUNT of the postings of the shop order x -1 (blocked: gl-labour-postings)` |
| 5 | Labour cost per work centre (one per work centre) | A column representing each work centre, showing the proportion of actual labour cost borne by each work centre | `Labour Cost (from GL) x (standard cost of the work centre / sum of the standard costs of all work centres) (blocked: routing-standard-cost)` |
| 6 | Standard Labour Cost per unit | Labour Cost as per standard cost calculation | `sum of PART_COST_BUCKET.BUCKET_LEVEL_COST of the cost buckets 201 and 221, cost set 1` |
| 7 | Standard Labour Cost per unit per Work Centre (one per work centre) | A column representing each work centre, showing the proportion of standard labour cost borne by the work centre | `sum of the standard labour cost per unit of the operations on the work centre (blocked: routing-standard-cost)` |

## Calculations in the specification

**Standard labour cost per unit, per routing operation (specification, section 5.1)**

```
Standard Labour Cost per unit per operation =
  Setup Labour rate x Setup Crew Size x (Labour Setup Time / Std Lot Size)
+ Setup Overhead rate x (Labour Setup Time / Std Lot Size)
+ Labour rate x Crew Size x Labour run factor
+ Overhead rate x Labour run factor
```

- The rates come from cost set 1 of the labour class: the Setup Labour Class gives the setup rates, the Labour Class gives the run rates.
- As written, the overhead terms are not multiplied by a crew size.
- The operations that share a work centre are added up (two operations can be on one work centre).
- Worked example from the screenshots of the specification: part TEST-PART-001, std lot size 10, labour class DEF (rate 50, overhead 60). Operation 1 on WC 01 (setup crew 5, crew 3, setup time 1, run factor 2) = 25 + 6 + 300 + 120 = 451. Operation 2 on WC 02 (setup crew 7, crew 4, setup time 2, run factor 3) = 70 + 12 + 600 + 180 = 862. The values are read from the screenshots of the specification; they are not a result of the report.

**Actual labour cost per work centre (specification, section 5.1)**

```
Actual Cost per work centre =
  Actual Labour Cost from GL x (Standard Labour Cost per unit of the work centre / Sum of the Standard Labour Cost per unit of all work centres)
```

- The actual labour cost of a shop order is spread in the proportion of the standard cost. The specification does not say what to show when the standard costs add up to zero (division by zero).

**Actual labour cost from the general ledger**

```
Labour Cost (from GL) = (sum of the field Amount of the postings of the shop order) x -1
```

- The postings are those of the company, with transaction code M42, M58, M124, M125, M132 or M133 and a voucher date between the From Date and the To Date.

**Standard labour cost of the part, from Part Cost**

```
Standard Labour Cost per unit = Labour Setup cost + Labour Overhead cost of the manufactured part (Part Cost window, cost set 1)
```

- The screenshot marks the cost buckets 201 (Labor Setup Cost) and 221 (Labor Overhead Cost). The bucket 200 (Labor Runtime Cost) is not marked, although the formula above has run-time labour terms.
- The specification notes that this should equal the actual labour cost per part, because variance postings at shop order closure post the difference.


## Data source: work-centres (ready)

The work centres of all sites of the company: each of them is a pair of columns in the report.

Views used:

- `WORK_CENTER`: work centre number and description per site
- `COMPANY_SITE`: the sites of the company

```sql
SELECT w.contract AS "Site",
       w.work_center_no AS "Work Centre",
       w.description AS "Description"
  FROM work_center w
  JOIN company_site cs
    ON cs.contract = w.contract
 WHERE cs.company = '&Company'
 ORDER BY w.contract, w.work_center_no
```

Assumptions:

- All work centres of the sites are taken, active or not: the specification does not mention the validity.

## Data source: closed-shop-orders (draft)

The closed shop orders of the company with their completed quantity. The report keeps those that have labour postings in the period (see gl-labour-postings).

Views used:

- `SHOP_ORD`: shop order, part, status, completed quantity, routing revision
- `COMPANY_SITE`: the sites of the company

```sql
SELECT so.order_no AS "Shop Order",
       so.release_no AS "Release No",
       so.sequence_no AS "Sequence No",
       so.part_no AS "Part No",
       so.contract AS "Site",
       so.state AS "Status",
       so.qty_complete AS "Completed Qty",
       so.routing_revision AS "Routing Revision",
       so.close_date AS "Close Date"
  FROM shop_ord so
  JOIN company_site cs
    ON cs.contract = so.contract
 WHERE cs.company = '&Company'
   AND so.state = 'Closed'
```

Assumptions:

- The status is selected by its displayed value 'Closed'; the first test run confirms it (a database value or another language can differ).
- Shop order number, release number and sequence number together identify a shop order; the specification only says Shop Order number.

## Data source: standard-part-cost (draft)

The standard labour cost per unit of each part: the labour setup cost plus the labour overhead cost of cost set 1.

Views used:

- `PART_COST_BUCKET`: cost buckets of a part per cost set (bucket level cost and accumulated cost)

```sql
SELECT pcb.contract AS "Site",
       pcb.part_no AS "Part No",
       SUM(pcb.bucket_level_cost) AS "Standard Labour Cost per unit"
  FROM part_cost_bucket pcb
 WHERE pcb.cost_set = 1
   AND pcb.cost_bucket_id IN ('201', '221')
 GROUP BY pcb.contract, pcb.part_no
```

Assumptions:

- The cost buckets are 201 (Labor Setup Cost) and 221 (Labor Overhead Cost), as marked in the screenshot of the specification.
- The Level Cost is used, not the Accumulated Cost.
- The key of PART_COST_BUCKET also holds the structure alternative, routing alternative, bucket level and top level part; adding the rows of all of them could count a cost twice. The first test run shows it.

## Data source: gl-labour-postings (blocked)

The labour postings of the period per shop order: from them the distinct shop orders and the actual labour cost (sum of the amounts x -1).

Views used:

- `GEN_LED_VOUCHER_ROW`: the voucher rows (the GL Voucher Rows Analysis)
- `MPCCOM_ACCOUNTING`: the manufacturing postings with their voucher and event code

**No SQL yet.** Blocked by:

- No column that holds the shop order number was found on the voucher row views of the data dictionary (GEN_LED_VOUCHER_ROW and the similar views). Which field of the GL Voucher Rows Analysis window shows the shop order?
- Which column holds the transaction code (M42, M58, M124, M125, M132, M133): TRANS_CODE of the voucher row, or the posting event code (STR_CODE) of MPCCOM_ACCOUNTING?

What is already known:

- Company = the Company parameter.
- Transaction code in (M42, M58, M124, M125, M132, M133).
- Voucher date between the From Date and the To Date (GEN_LED_VOUCHER_ROW.VOUCHER_DATE).
- The amount is GEN_LED_VOUCHER_ROW.AMOUNT (signed); there are also DEBET_AMOUNT and CREDIT_AMOUNT.
- GEN_LED_VOUCHER_ROW has COMPANY, VOUCHER_TYPE, ACCOUNTING_YEAR, VOUCHER_NO, ROW_NO, TRANS_CODE, AMOUNT, VOUCHER_DATE, TEXT, REFERENCE_NUMBER and the code parts B to J; MPCCOM_ACCOUNTING has the same voucher keys and STR_CODE, but neither view has a shop order column in the data dictionary.


## Data source: routing-standard-cost (blocked)

The standard labour cost per unit of each routing operation, and from it per work centre.

Views used:

- `ROUTING_OPERATION`: the operations with crew sizes, times, run factor, labour classes and work centre
- `LABOR_CLASS_COST`: the labour rate and overhead of a labour class per cost set
- `ROUTING_HEAD`: the routing of a part

**No SQL yet.** Blocked by:

- Std Lot Size: no column with this prompt was found on the routing views of the data dictionary (ROUTING_HEAD, ROUTING_ALTERNATE, ROUTING_OPERATION). Where is it stored?
- Which routing is meant: the shop order stores the routing revision, but a part can have several alternates and states (the screenshots show the states Buildable and Tentative).
- The labour class rates (LABOR_CLASS_COST) have a start date and an end date: at which date is the rate taken?
- The overhead of a labour class is given per an overhead unit (the screenshot shows Hour). The formula multiplies it by a time, which only holds when the unit is Hour.

What is already known:

- ROUTING_OPERATION has OPERATION_NO, WORK_CENTER_NO, SETUP_LABOR_CLASS_NO, LABOR_CLASS_NO, SETUP_CREW_SIZE, CREW_SIZE, LABOR_SETUP_TIME and LABOR_RUN_FACTOR.
- LABOR_CLASS_COST has LABOR_CLASS_RATE and OVERHEAD_FAC per site, labour class, cost set (1 is Inventory Value) and start date.
- The work centre of an operation is ROUTING_OPERATION.WORK_CENTER_NO; the operations of one work centre are added up.


## Decisions for the consultant

### How the work centre columns are made

The report has a pair of columns for every work centre of the company, and the number of work centres is not fixed. A quick report is one SQL statement with a fixed list of columns. Which way should it be built?

- **Fixed columns for a given list of work centres**: The SQL names each work centre as a column. It is simple and fast, but a new work centre needs a change of the report. It needs the list of work centres of the sample company from the consultant.
- **Columns generated when the report runs**: A new work centre needs no change, but a quick report cannot change its columns by itself. It needs a way to generate the SQL at run time, and it is not known whether the quick report function supports that.
- **One row per shop order and work centre**: No changing columns, and plain SQL works. The consultant can pivot the result in Excel, but it does not match the layout of the specification (one row per shop order).

### Which shop orders belong to the week

The specification lists two open issues: shop orders started in the week but not closed, and shop orders closed in the week but not started in the same week. The text of the functional solution takes the shop orders that have labour postings in the week and are Closed now.

- **Postings in the week and status Closed (the text of the specification)**: An order closed after the week is left out of that week, and an order with postings in several weeks appears in each of them with only the cost of that week.
- **Only orders closed in the week**: Needs the close date as an extra condition (SHOP_ORD.CLOSE_DATE), and leaves out the postings of earlier weeks of the same order.
- **Postings in the week, any status**: Includes orders that are still open, so the Status column no longer always says Closed, which the specification states.


## Validation

Status: **not run**.

Checked against the IFS data dictionary (IFS Cloud 25R2): 21 column reference(s) checked, 0 unknown, 0 unknown view(s).

To confirm when the SQL is run on a test environment:

- The three SQL statements that are written run and return rows for the sample company.
- The status value: the SQL uses the displayed value 'Closed' for SHOP_ORD.STATE.
- The Part Cost SQL counts a cost bucket once per part (structure and routing alternatives, bucket level).
- For a closed shop order the standard labour cost per unit of the part agrees with the actual labour cost per part, as the specification states.

## Questions for the consultant

1. Which field of the GL Voucher Rows Analysis shows the shop order? The data dictionary has no shop order column on the voucher row views.
2. Which column holds the transaction code (M42, M58, M124, M125, M132, M133)?
3. Which amount is meant by Amount: the signed Amount, or debit minus credit? The specification multiplies the sum by -1.
4. Where is the Std Lot Size stored? No column with that name was found on the routing views.
5. Which routing is used for the standard cost: the routing revision of the shop order, and which alternate and state? The screenshots show the states Buildable and Tentative.
6. Part Cost: the specification adds the Labour Setup cost and the Labour Overhead cost but not the Labor Runtime cost (bucket 200), although the formula has run-time labour terms. Is that intended? And is the Level Cost or the Accumulated Cost meant?
7. Labour class rates: at which date is the rate of cost set 1 taken, when the rate has several start dates?
8. Labour class overhead: is the overhead always given per Hour? The formula multiplies it by a time.
9. What should the work centre columns show when the standard costs of all work centres add up to zero (division by zero)?
10. The two open issues of the specification (started but not closed in the week, closed but not started in the week) are still undecided, see the decision on the shop order selection.
11. How the work centre columns are made is a decision for the consultant, see the options above.
12. Parameters: how are the default dates given (the start of the previous week: Monday or Sunday?), and in which format does a quick report pass a date parameter?
13. Should inactive work centres be included in the columns?
14. The report mixes totals (actual cost per work centre) and per-unit amounts (standard cost per unit). Is that as intended?

Approve the design, or tell me what to change.
