# Order API

Order creation validates live prices, stock, store eligibility, and writes a parent order with store-scoped sub-orders. Protected reads are scoped by internal `customerUserId`; store operations resolve internal `ownerUserId`. Client IDs and totals are never authorization or pricing authority.
