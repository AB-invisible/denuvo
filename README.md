# GameGen Discord Bot

Premium game selection and ticket system for Denuvo games.

## Features
- **Dynamic Selection Panel**: Sorted A-Z game dropdowns with real-time stock status.
- **Ticket System**: Automated ticket creation with setup guides from `info.md`.
- **Stock Management**: Staff-only commands to manage game tokens.
- **Premium Design**: High-quality embeds inspired by modern gaming lounge aesthetics.

## Setup
1. **Database**: 
   - Ensure PostgreSQL is running.
   - Update `DATABASE_URL` in `.env`.
   - Run `npx prisma db push` to create tables.
   - Run `npm run prisma:seed` to import games from `denuvo.json`.

2. **Discord Bot**:
   - Create an application at [Discord Developer Portal](https://discord.com/developers/applications).
   - Get the **Token**, **Client ID**, and your **Server (Guild) ID**.
   - Fill these in the `.env` file.
   - Create a Category for tickets and put its ID in `TICKET_CATEGORY_ID`.

3. **Installation**:
   ```bash
   npm install
   npx prisma generate
   ```

4. **Running**:
   ```bash
   npm start
   ```

## Commands
- `/postpanel`: Posts the main game selection panel (Admin only).
- `/stock add <game> <amount>`: Add stock to a game.
- `/stock remove <game> <amount>`: Remove stock from a game.
- `/stock set <game> <amount>`: Set exact stock for a game.

## Configuration
- **Staff Role**: `1484195272270811226` (Hardcoded as requested).
- **Bot Name**: `GameGen`.
