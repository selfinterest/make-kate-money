#!/bin/bash

# Script to manually trigger the ticker update Lambda function
# Usage: ./scripts/update-tickers.sh [dry-run|force]

set -e

FUNCTION_NAME_PREFIX="RedditStockWatcherStack-UpdateTickers-Function"
DRY_RUN=${1:-"false"}
FORCE=${2:-"false"}

# Get the actual function name
FUNCTION_NAME=$(aws lambda list-functions --query "Functions[?starts_with(FunctionName, '$FUNCTION_NAME_PREFIX')].FunctionName" --output text)

if [ -z "$FUNCTION_NAME" ]; then
    echo "Error: Could not find UpdateTickers Lambda function"
    echo "Make sure the stack is deployed and the function name starts with: $FUNCTION_NAME_PREFIX"
    exit 1
fi

echo "Found function: $FUNCTION_NAME"

# Prepare the event payload
if [ "$DRY_RUN" = "true" ]; then
    PAYLOAD='{"dryRun": true}'
    echo "Running in DRY RUN mode..."
elif [ "$FORCE" = "true" ]; then
    PAYLOAD='{"force": true}'
    echo "Running with FORCE flag..."
else
    PAYLOAD='{}'
    echo "Running normal update..."
fi

# Invoke the function
echo "Invoking function..."
RESPONSE=$(aws lambda invoke \
    --function-name "$FUNCTION_NAME" \
    --payload "$PAYLOAD" \
    --cli-binary-format raw-in-base64-out \
    /tmp/ticker-update-response.json)

echo "Function invoked successfully!"
echo "Response saved to: /tmp/ticker-update-response.json"

# Display the response
echo ""
echo "Response:"
cat /tmp/ticker-update-response.json | jq '.'

# Clean up
rm -f /tmp/ticker-update-response.json

echo ""
echo "Done!"
