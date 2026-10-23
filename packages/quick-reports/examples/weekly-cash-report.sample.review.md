# Sample Weekly Cash Report (SQL quick report)

Customer Sample Customer, ticket TEST-001, specification A1 (sample).

Insight into the weekly cash flow: the most recent paid invoice of each customer connected to the selected company.

## Parameters

| Parameter | Type | Mandatory | Default | Used in the SQL as |
|---|---|---|---|---|
| Company ID | string | yes | none | `'&Company'` |

## Columns of the report

| # | Column | Where the specification takes it from | Source in IFS |
|---|---|---|---|
| 1 | Customer ID | Customer ID of each customer | `CUSTOMER_INFO.CUSTOMER_ID` |
| 2 | Name | Customer Name | `CUSTOMER_INFO.NAME` |
| 3 | Invoice Series | Inv/Prepayment Series ID of the most recent paid invoice | `LEDGER_TRANSACTION_CU_QRY.LEDGER_ITEM_SERIES_ID` |
| 4 | Invoice No | Inv/Prepayment No of the most recent paid invoice | `LEDGER_TRANSACTION_CU_QRY.LEDGER_ITEM_ID` |
| 5 | Status | Get the status of the invoice from the customer invoice | `INVOICE_LEDGER_ITEM_CU_QRY.LEDGER_STATUS_TYPE` |
| 6 | Invoice Amount | Get the Inv/Prepayment Amount from the ledger item | `INVOICE_LEDGER_ITEM_CU_QRY.INVOICE_AMOUNT` |
| 7 | Invoice Date | Get the Inv/Prepayment Date from the ledger item | `INVOICE_LEDGER_ITEM_CU_QRY.INVOICE_DATE` |
| 8 | Payment Terms | Get the Payment terms from Customer Analysis | `IDENTITY_INVOICE_INFO.PAY_TERM_ID` |
| 9 | Next/Last Due Date | Get the Next/Last Due Date from the ledger item | `INVOICE_LEDGER_ITEM_CU_QRY.DUE_DATE` |
| 10 | Currency Code | Get the currency from the ledger item | `INVOICE_LEDGER_ITEM_CU_QRY.CURRENCY` |
| 11 | Payment Date | Get the payment date from the cash transaction | `LEDGER_TRANSACTION_CU_QRY.PAY_DATE` |

## Data source: latest-paid-invoice-per-customer (ready)

One row per customer of the company: the invoice that was paid by the customer's latest customer payment.

Views used:

- `IDENTITY_INVOICE_INFO`: the customers connected to the company (the Customer/Invoice tab), and their payment terms
- `CUSTOMER_INFO`: customer name
- `LEDGER_TRANSACTION_CU_QRY`: customer payment transactions with payment date, payment type and the invoice that was paid (the Customer Analysis window)
- `INVOICE_LEDGER_ITEM_CU_QRY`: the invoice of the customer ledger: invoice amount, invoice date, due date, currency, ledger status

```sql
SELECT cust.customer_id AS "Customer ID",
       cust.name AS "Name",
       lt.ledger_item_series_id AS "Invoice Series",
       lt.ledger_item_id AS "Invoice No",
       li.ledger_status_type AS "Status",
       li.invoice_amount AS "Invoice Amount",
       li.invoice_date AS "Invoice Date",
       iii.pay_term_id AS "Payment Terms",
       li.due_date AS "Next/Last Due Date",
       li.currency AS "Currency Code",
       lt.pay_date AS "Payment Date"
  FROM identity_invoice_info iii
  JOIN customer_info cust
    ON cust.customer_id = iii.identity
  JOIN (SELECT t.company, t.identity, t.ledger_company, t.ledger_item_series_id, t.ledger_item_id, t.ledger_item_version, t.pay_date,
               ROW_NUMBER() OVER (PARTITION BY t.company, t.identity ORDER BY t.pay_date DESC, t.payment_id DESC, t.trans_id DESC) AS rn
          FROM ledger_transaction_cu_qry t
         WHERE t.company = '&Company'
           AND t.payment_type_code = 'Customer Payment') lt
    ON lt.company = iii.company
   AND lt.identity = iii.identity
   AND lt.rn = 1
  LEFT JOIN invoice_ledger_item_cu_qry li
    ON li.company = lt.ledger_company
   AND li.identity = lt.identity
   AND li.series_id = lt.ledger_item_series_id
   AND li.invoice_no = lt.ledger_item_id
   AND li.ledger_item_version = lt.ledger_item_version
 WHERE iii.company = '&Company'
   AND iii.party_type_db = 'CUSTOMER'
 ORDER BY cust.customer_id
```

Assumptions:

- The latest payment is the one with the latest Payment Date; payment id and transaction id break a tie.
- The customers connected to the company are the rows of IDENTITY_INVOICE_INFO with party type customer.
- The payment is joined to its invoice by company, customer, invoice series, invoice no and version (LEDGER_TRANSACTION_CU_QRY.LEDGER_ITEM_SERIES_ID and LEDGER_ITEM_ID against INVOICE_LEDGER_ITEM_CU_QRY.SERIES_ID and INVOICE_NO). The columns exist in the data dictionary; whether the ledger item id always equals the invoice no is confirmed by the first test run, with INVOICE_ID as the alternative join.

## Validation

Status: **not run**.

Checked against the IFS data dictionary (IFS Cloud 25R2): 26 column reference(s) checked, 0 unknown, 0 unknown view(s).

To confirm when the SQL is run on a test environment:

- The SQL runs and returns rows for a company that has customer payments.
- The value of Payment Type: the SQL uses the displayed value 'Customer Payment'. If the test environment uses another language, or the column holds a code, use PAYMENT_TYPE_CODE_DB with its database value.
- Each customer appears once, and the invoice shown is the one of the latest payment.
- The join of the payment to its invoice returns one invoice per payment (series and invoice no; the alternative is INVOICE_ID), and no invoice twice because of ledger item versions.
- The run time for the biggest company.

## Questions for the consultant

1. Customers that have no customer payment at all are left out of the report. Should they appear with empty invoice columns?
2. Status: the design uses the ledger status of the invoice (Ledger Status). If the status of the customer invoice itself is meant (the state of the invoice), the source is another view.
3. Payments that were rolled back are not excluded, because the specification does not say. Should they be?
4. Next/Last Due Date: the design shows the due date of the ledger item. Is a next due date of another open invoice meant?
5. The permission sets and the report category are still to be decided.
6. The specification says the data is presented in a format that is shown as a picture; the columns were taken from the Report Layout table.

Approve the design, or tell me what to change.
