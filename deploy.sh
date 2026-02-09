#!/bin/bash
# Quick deployment script for Deno YouTube Downloader

set -e  # Exit on error

echo "🦕 Deno YouTube Downloader - Quick Deploy"
echo "=========================================="
echo ""

# Check if Deno is installed
if ! command -v deno &> /dev/null; then
    echo "❌ Deno not found. Installing..."
    curl -fsSL https://deno.land/install.sh | sh
    export PATH="$HOME/.deno/bin:$PATH"
fi

# Check if yt-dlp is installed
if ! command -v yt-dlp &> /dev/null; then
    echo "⚠️  yt-dlp not found. Please install:"
    echo "    pip3 install --break-system-packages yt-dlp"
    echo ""
fi

# Create directory structure
echo "📁 Creating directory structure..."
mkdir -p public
mkdir -p downloads

# Copy frontend if not exists
if [ ! -f "public/index.html" ]; then
    if [ -f "index.html" ]; then
        echo "📄 Copying index.html to public/"
        cp index.html public/
    else
        echo "⚠️  index.html not found. Place it in public/ manually."
    fi
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "Choose deployment method:"
echo "  1) Development (run directly)"
echo "  2) Compile binary"
echo "  3) Docker"
echo ""
read -p "Enter choice [1-3]: " choice

case $choice in
    1)
        echo ""
        echo "🚀 Starting development server..."
        echo "   Visit: http://localhost:8000"
        echo ""
        deno run --allow-net --allow-read --allow-write --allow-run --allow-env api.ts
        ;;
    2)
        echo ""
        echo "🔨 Compiling binary..."
        deno compile \
            --allow-net --allow-read --allow-write --allow-run --allow-env \
            --output ytdl \
            api.ts
        echo ""
        echo "✅ Binary created: ./ytdl"
        echo "   Run with: ./ytdl"
        ;;
    3)
        echo ""
        if ! command -v docker &> /dev/null; then
            echo "❌ Docker not found. Please install Docker first."
            exit 1
        fi
        
        echo "🐳 Building Docker image..."
        docker build -f Dockerfile.deno -t ytdl:latest .
        
        echo ""
        echo "✅ Image built successfully!"
        echo ""
        read -p "Start container now? [y/N]: " start_docker
        
        if [ "$start_docker" = "y" ] || [ "$start_docker" = "Y" ]; then
            echo "🚀 Starting container..."
            docker run -d \
                --name ytdl \
                -p 8000:8000 \
                -v $(pwd)/downloads:/app/downloads \
                ytdl:latest
            
            echo ""
            echo "✅ Container started!"
            echo "   Visit: http://localhost:8000"
            echo "   Logs: docker logs -f ytdl"
            echo "   Stop: docker stop ytdl"
        fi
        ;;
    *)
        echo "Invalid choice"
        exit 1
        ;;
esac

echo ""
echo "🎉 Deployment complete!"
