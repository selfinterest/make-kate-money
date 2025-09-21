#!/bin/bash

# Script to update AWS Parameter Store values for Reddit Stock Watcher
# Usage: ./scripts/update-parameters.sh

set -e

echo "🔧 Updating Reddit Stock Watcher Parameter Store values..."

# Check if AWS CLI is available
if ! command -v aws &> /dev/null; then
    echo "❌ AWS CLI is not installed. Please install it first."
    exit 1
fi

# Function to update parameter with user input
update_parameter() {
    local param_name=$1
    local description=$2
    local current_value
    
    echo ""
    echo "📝 Parameter: $param_name"
    echo "   Description: $description"
    
    # Get current value (if exists and not placeholder)
    current_value=$(aws ssm get-parameter --name "/reddit-stock-watcher/$param_name" --query 'Parameter.Value' --output text 2>/dev/null || echo "REPLACE_ME")
    
    if [[ "$current_value" != "REPLACE_ME" && "$current_value" != "" ]]; then
        echo "   Current value: ${current_value:0:10}..." # Show first 10 chars for security
        read -p "   Keep current value? (y/n): " keep_current
        if [[ "$keep_current" == "y" || "$keep_current" == "Y" ]]; then
            echo "   ✅ Keeping current value"
            return
        fi
    fi
    
    read -p "   Enter new value: " new_value
    
    if [[ -z "$new_value" ]]; then
        echo "   ⚠️  Skipping empty value"
        return
    fi
    
    aws ssm put-parameter --name "/reddit-stock-watcher/$param_name" --value "$new_value" --overwrite
    echo "   ✅ Updated successfully"
}

# Required parameters
echo "🔐 Required Parameters:"
update_parameter "REDDIT_CLIENT_ID" "Reddit app client ID"
update_parameter "REDDIT_CLIENT_SECRET" "Reddit app client secret"
update_parameter "REDDIT_USERNAME" "Reddit username"
update_parameter "REDDIT_PASSWORD" "Reddit password"
update_parameter "SUPABASE_URL" "Supabase project URL"
update_parameter "SUPABASE_API_KEY" "Supabase service role key"
update_parameter "OPENAI_API_KEY" "OpenAI API key"
update_parameter "RESEND_API_KEY" "Resend API key"
update_parameter "EMAIL_FROM" "Email sender address"
update_parameter "EMAIL_TO" "Email recipient address"

# Optional parameters with defaults
echo ""
echo "⚙️  Optional Parameters (press Enter to use defaults):"
update_parameter "SUBREDDITS" "Subreddits to monitor (default: stocks,investing,wallstreetbets,pennystocks)"
update_parameter "LLM_BATCH_SIZE" "Posts per LLM batch (default: 10)"
update_parameter "MIN_SCORE_FOR_LLM" "Minimum Reddit score for LLM processing (default: 1)"
update_parameter "QUALITY_THRESHOLD" "Minimum quality score for email (default: 3)"
update_parameter "MAX_POSTS_PER_RUN" "Maximum posts per execution (default: 120)"
update_parameter "CRON_WINDOW_MINUTES" "Time window for fetching posts (default: 5)"
update_parameter "LLM_MAX_BODY_CHARS" "Maximum body text length for LLM (default: 2000)"

echo ""
echo "🎉 Parameter update complete!"
echo ""
echo "💡 Test your Lambda function:"
echo "   aws lambda invoke --function-name RedditStockWatcherStack-PollFunction* --payload '{}' response.json"
echo ""
echo "📊 Monitor logs:"
echo "   aws logs tail --follow /aws/lambda/RedditStockWatcherStack-PollFunction*"