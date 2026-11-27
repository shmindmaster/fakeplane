# Operations

Exit 1 is the product working: the document should not be ingested.
Exit 2 means the file was missing, encrypted, or not a supported format.
Fix the input. Do not lower `--fail-on` to make a pipeline green.

An OCR text layer on a full-page image is reported as `info`, not as a
hidden instruction. Invisible render mode on any other page is a finding.

The local image tag is `subtext-scan:local`. Remove it with
`docker image rm subtext-scan:local` when you want the disk back.
Docker is started for the task and is not a login item.
