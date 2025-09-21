#!/bin/bash

# Script to update AWS Parameter Store values from .env file
# Usage: ./scripts/update-parameters-from-env.sh [path-to-env-file] [aws-profile]
# If no path provided, defaults to .env in project root
# If no profile provided, uses current AWS credentials

# Don't exit on errors - we want to process all parameters
# set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🔧 Updating Parameter Store from .env file...${NC}"

# Check if AWS CLI is available
if ! command -v aws &> /dev/null; then
    echo -e "${RED}❌ AWS CLI is not installed. Please install it first.${NC}"
    exit 1
fi

# Determine .env file path and AWS profile
ENV_FILE=${1:-".env"}
# Only override AWS_PROFILE if a second argument is provided
if [[ -n "$2" ]]; then
    AWS_PROFILE="$2"
fi

if [[ ! -f "$ENV_FILE" ]]; then
    echo -e "${RED}❌ .env file not found: $ENV_FILE${NC}"
    echo -e "${YELLOW}💡 Create a .env file with your parameters, e.g.:${NC}"
    echo "   REDDIT_CLIENT_ID=your_client_id_here"
    echo "   REDDIT_CLIENT_SECRET=your_secret_here"
    echo "   # etc..."
    exit 1
fi

echo -e "${BLUE}📄 Reading from: $ENV_FILE${NC}"

# Set up AWS profile if provided
if [[ -n "$AWS_PROFILE" ]]; then
    export AWS_PROFILE="$AWS_PROFILE"
    echo -e "${BLUE}🔐 Using AWS profile: $AWS_PROFILE${NC}"
fi

# Test AWS credentials
echo -e "${BLUE}🔍 Testing AWS credentials...${NC}"
if ! aws sts get-caller-identity > /dev/null 2>&1; then
    echo -e "${RED}❌ AWS credentials not working. Try:${NC}"
    echo "   • Set AWS profile: export AWS_PROFILE=your-profile-name"
    echo "   • Or run: aws configure"
    echo "   • Or run: aws sso login --profile your-profile-name"
    exit 1
fi

# Show current AWS identity
CALLER_IDENTITY=$(aws sts get-caller-identity --query 'Arn' --output text 2>/dev/null || echo "unknown")
echo -e "${GREEN}✅ AWS credentials working: $CALLER_IDENTITY${NC}"

# Parameter prefix for AWS Parameter Store
PARAM_PREFIX="/reddit-stock-watcher"

# Counter for tracking updates
UPDATED=0
SKIPPED=0
ERRORS=0

# Function to update a single parameter
update_parameter() {
    local key=$1
    local value=$2
    local param_name="$PARAM_PREFIX/$key"
    
    # Skip empty values
    if [[ -z "$value" ]]; then
        echo -e "${YELLOW}⚠️  Skipping empty value for $key${NC}"
        ((SKIPPED++))
        return
    fi
    
    # Show masked value for security (first 8 chars + ...)
    local masked_value
    if [[ ${#value} -gt 8 ]]; then
        masked_value="${value:0:8}..."
    else
        masked_value="$value"
    fi
    
    echo -e "${BLUE}📝 Updating $key = $masked_value${NC}"
    
    # Update parameter in AWS
    local error_output
    if error_output=$(aws ssm put-parameter --name "$param_name" --value "$value" --overwrite --type "SecureString" 2>&1); then
        echo -e "${GREEN}   ✅ Updated successfully${NC}"
        ((UPDATED++))
    else
        echo -e "${RED}   ❌ Failed to update: ${error_output}${NC}"
        ((ERRORS++))
    fi
}

# Read and process .env file
echo -e "${BLUE}🔄 Processing environment variables...${NC}"
echo ""

# Read .env file, skip comments and empty lines
while IFS= read -r line || [[ -n "$line" ]]; do
    # Skip comments and empty lines
    if [[ "$line" =~ ^[[:space:]]*# ]] || [[ -z "${line// }" ]]; then
        continue
    fi
    
    # Parse KEY=VALUE format
    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
        key="${BASH_REMATCH[1]}"
        value="${BASH_REMATCH[2]}"
        
        # Remove surrounding quotes if present
        value="${value%\"}"
        value="${value#\"}"
        value="${value%\'}"
        value="${value#\'}"
        
        update_parameter "$key" "$value"
    else
        echo -e "${YELLOW}⚠️  Skipping invalid line: $line${NC}"
        ((SKIPPED++))
    fi
done < "$ENV_FILE"

echo ""
echo -e "${GREEN}🎉 Parameter update complete!${NC}"
echo -e "${GREEN}   Updated: $UPDATED${NC}"
echo -e "${YELLOW}   Skipped: $SKIPPED${NC}"
if [[ $ERRORS -gt 0 ]]; then
    echo -e "${RED}   Errors: $ERRORS${NC}"
fi

echo ""
echo -e "${BLUE}💡 Next steps:${NC}"
echo "   • Test your Lambda function:"
echo "     aws lambda invoke --function-name RedditStockWatcherStack-PollFunction* --payload '{}' response.json"
echo ""
echo "   • Monitor logs:"
echo "     aws logs tail --follow /aws/lambda/RedditStockWatcherStack-PollFunction*"
echo ""
echo "   • View parameters in AWS Console:"
echo "     https://console.aws.amazon.com/systems-manager/parameters/?tab=Table"
