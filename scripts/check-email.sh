#!/bin/bash
cd /opt/mandamail
docker compose exec -T postgres psql -U app emailbitrix -t -c "SELECT LENGTH(body_html), body_html LIKE '%data:image%' as has_data_uri, body_html LIKE '%cid:%' as has_cid, body_html LIKE '%<img%' as has_img FROM email_events WHERE id='05ef15fd-6ac4-4857-87a0-c3903d679c64'"
