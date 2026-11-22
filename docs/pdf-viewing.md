# PDF viewing

Ordinary workspaces use Chromium's PDF viewer. Use **Find…** or **Print…** from
the Browser menu. **Open PDF in new tab** reopens a PDF that the site serves
through a reusable address. **Save PDF…** follows the Account Space's normal
download permission. A site may require a fresh login or issue a one-use link.

Banking opens an isolated **Protected PDF** preview with page navigation and text
search. The browser refuses print and download and blocks the native embedded PDF
viewer in this workspace. **Open protected preview** retries the same read in the
original Account Space with redirects blocked. The preview supports PDFs up to
12 MiB and 250 pages. For login, expired links, larger files or PDF responses that
require a form submission, return to the original site or ask it for a readable
copy. Scans without a text layer cannot be searched.

The Windows browser test covers native text search, opening in a separate tab,
permission-gated saving with a byte comparison, and the protected preview. Banking
tests verify that the application rejects both saving and printing, including
keyboard shortcuts, and blocks embedded native PDF content.
