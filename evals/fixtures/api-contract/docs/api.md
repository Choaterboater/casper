# Pagination API (v1)

`GET /items?page=<n>&size=<m>` returns at most **100** items per page. A `size`
above 100 is clamped to 100; clients that need more rows request further pages.

This limit is part of the v1 contract: client SDKs allocate fixed buffers of 100
rows and paginate on that assumption. Raising it requires API v2.
