import type { ActivityDetails } from "@wealthfolio/addon-sdk"
import type { ClosedTrade, OpenPosition, TradeMatchResult } from "../types"
import { differenceInDays } from "date-fns"

interface Lot {
  activity: ActivityDetails
  remainingQuantity: number
  originalQuantity: number
  dividends: ActivityDetails[]
}

interface AverageLot {
  symbol: string
  totalQuantity: number
  totalCostBasis: number
  averagePrice: number
  activities: ActivityDetails[]
  remainingQuantity: number
  dividends: ActivityDetails[]
}

export interface TradeMatcherOptions {
  lotMethod?: "FIFO" | "LIFO" | "AVERAGE"
  includeFees?: boolean
  includeDividends?: boolean
}

/**
 * TradeMatcher class for matching buy and sell activities to compute closed trades and open positions
 */
export class TradeMatcher {
  private lotMethod: "FIFO" | "LIFO" | "AVERAGE"
  private includeFees: boolean
  private includeDividends: boolean

  constructor(options: TradeMatcherOptions = {}) {
    this.lotMethod = options.lotMethod || "FIFO"
    this.includeFees = options.includeFees !== false // Default to true
    this.includeDividends = options.includeDividends !== false // Default to true
  }

  /**
   * Match trades from a list of activities
   */
  matchTrades(activities: ActivityDetails[]): TradeMatchResult {
    // Ensure all numeric fields are properly parsed
    const parsedActivities = this.parseActivities(activities)
    
    // Separate trading activities from dividends
    const tradingActivities = parsedActivities.filter(
      a => a.activityType === "BUY" || 
           a.activityType === "SELL" || 
           a.activityType === "SELL_SHORT" || 
           a.activityType === "BUY_COVER"
    )
    const dividendActivities = parsedActivities.filter(a => a.activityType === "DIVIDEND")
    
    // Group activities by symbol
    const bySymbol = this.groupBySymbol(tradingActivities)
    const dividendsBySymbol = this.groupBySymbol(dividendActivities)

    const closedTrades: ClosedTrade[] = []
    const openPositions: OpenPosition[] = []
    const unmatchedBuys: ActivityDetails[] = []
    const unmatchedSells: ActivityDetails[] = []

    // Process each symbol separately
    for (const [symbol, symbolActivities] of Object.entries(bySymbol)) {
      const symbolDividends = dividendsBySymbol[symbol] || []
      const result = this.matchSymbolTrades(symbol, symbolActivities, symbolDividends)

      closedTrades.push(...result.closedTrades)
      openPositions.push(...result.openPositions)
      unmatchedBuys.push(...result.unmatchedBuys)
      unmatchedSells.push(...result.unmatchedSells)
    }

    return {
      closedTrades,
      openPositions,
      unmatchedBuys,
      unmatchedSells,
    }
  }

  /**
   * Parse activities to ensure numeric fields are numbers
   */
  private parseActivities(activities: ActivityDetails[]): ActivityDetails[] {
    return activities.map(a => ({
      ...a,
      quantity: this.parseNumber(Math.abs(a.quantity)),
      unitPrice: this.parseNumber(a.unitPrice),
      fee: this.parseNumber(a.fee),
      amount: this.parseNumber(a.amount),
    }))
  }

  /**
   * Safely parse a value to number
   */
  private parseNumber(value: any): number {
    if (typeof value === 'number') return value
    if (typeof value === 'string') return parseFloat(value) || 0
    return 0
  }

  /**
   * Group activities by symbol
   */
  private groupBySymbol(activities: ActivityDetails[]): Record<string, ActivityDetails[]> {
    return activities.reduce(
      (acc, activity) => {
        const symbol = activity.assetSymbol
        if (!acc[symbol]) {
          acc[symbol] = []
        }
        acc[symbol].push(activity)
        return acc
      },
      {} as Record<string, ActivityDetails[]>,
    )
  }

  /**
   * Match trades for a specific symbol
   */
  private matchSymbolTrades(symbol: string, activities: ActivityDetails[], dividends: ActivityDetails[] = []): TradeMatchResult {
    // Sort activities chronologically
    const sortedActivities = [...activities].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    )

    if (this.lotMethod === "AVERAGE") {
      return this.matchSymbolTradesAverage(symbol, sortedActivities, dividends)
    } else {
      return this.matchSymbolTradesSpecific(symbol, sortedActivities, dividends)
    }
  }

  /**
   * Match trades using average cost method
   */
  private matchSymbolTradesAverage(
    symbol: string, 
    activities: ActivityDetails[],
    dividends: ActivityDetails[] = []
  ): TradeMatchResult {
    const closedTrades: ClosedTrade[] = []
    const openPositions: OpenPosition[] = []
    const unmatchedBuys: ActivityDetails[] = []
    const unmatchedSells: ActivityDetails[] = []

    let longAverageLot: AverageLot | null = null
    let shortAverageLot: AverageLot | null = null
    
    for (const activity of activities) {
      const activityType = activity.activityType;

      if (activityType === "BUY" || activityType === "BUY_COVER") {
        let buyQuantityRemaining = activity.quantity;

        // If there's a short position, this BUY/BUY_COVER will close it first
        if (shortAverageLot && shortAverageLot.remainingQuantity > 0) {
          const matchedQuantity = Math.min(buyQuantityRemaining, shortAverageLot.remainingQuantity);

          // Create a closed trade (covering the short)
          const closedTrade = this.createClosedTradeAverage(
            shortAverageLot,
            activity,
            matchedQuantity,
            symbol,
            true // isShortTrade
          );
          closedTrades.push(closedTrade);

          // Update quantities
          buyQuantityRemaining -= matchedQuantity;
          shortAverageLot.remainingQuantity -= matchedQuantity;

          if (shortAverageLot.remainingQuantity <= 0) {
            shortAverageLot = null;
          }
        }

        // If there's remaining quantity, it opens/adds to a long position
        if (buyQuantityRemaining > 0) {
          const buyActivityForLong = { ...activity, quantity: buyQuantityRemaining };
          if (!longAverageLot) {
            // *** FIX: Associate dividends at lot creation ***
            longAverageLot = this.createNewAverageLot(buyActivityForLong, symbol);
            if (this.includeDividends) {
              longAverageLot.dividends = dividends.filter(div => new Date(div.date) >= new Date(activity.date));
            }
          } else {
            // *** FIX: Update dividends when adding to a lot ***
            this.updateAverageLot(longAverageLot, buyActivityForLong);
            if (this.includeDividends) {
              const newDividends = dividends.filter(div => new Date(div.date) >= new Date(activity.date));
              const existingDivIds = new Set(longAverageLot.dividends.map(d => d.id));
              longAverageLot.dividends.push(...newDividends.filter(d => !existingDivIds.has(d.id)));
            }
          }
        }
      } else if (activityType === "SELL" || activityType === "SELL_SHORT") {
        let sellQuantityRemaining = activity.quantity;

        // If there's a long position, this SELL will close it first
        if (longAverageLot && longAverageLot.remainingQuantity > 0) {
          const matchedQuantity = Math.min(sellQuantityRemaining, longAverageLot.remainingQuantity);

          const closedTrade = this.createClosedTradeAverage(
            longAverageLot,
            activity,
            matchedQuantity,
            symbol
          );
          closedTrades.push(closedTrade);

          sellQuantityRemaining -= matchedQuantity;
          longAverageLot.remainingQuantity -= matchedQuantity;

          if (longAverageLot.remainingQuantity <= 0) {
            longAverageLot = null;
          }
        }

        // If there's remaining quantity, it opens/adds to a short position
        if (sellQuantityRemaining > 0) {
          const sellActivityForShort = { ...activity, quantity: sellQuantityRemaining };
          if (!shortAverageLot) {
            // *** FIX: Associate dividends at lot creation (for shorts) ***
            shortAverageLot = this.createNewAverageLot(sellActivityForShort, symbol);
            if (this.includeDividends) {
              shortAverageLot.dividends = dividends.filter(div => new Date(div.date) >= new Date(activity.date));
            }
          } else {
            // *** FIX: Update dividends when adding to a lot (for shorts) ***
            this.updateAverageLot(shortAverageLot, sellActivityForShort);
            if (this.includeDividends) {
              const newDividends = dividends.filter(div => new Date(div.date) >= new Date(activity.date));
              const existingDivIds = new Set(shortAverageLot.dividends.map(d => d.id));
              shortAverageLot.dividends.push(...newDividends.filter(d => !existingDivIds.has(d.id)));
            }
          }
        }
      }
    }

    // Create open long position
    if (longAverageLot && longAverageLot.remainingQuantity > 0) {
      const openPosition = this.createOpenPositionAverage(longAverageLot, symbol);
      openPositions.push(openPosition);
    }

    // Create open short position
    if (shortAverageLot && shortAverageLot.remainingQuantity > 0) {
      const openPosition = this.createOpenPositionAverage(shortAverageLot, symbol, true);
      // Make quantity negative for display
      openPosition.quantity = -openPosition.quantity;
      openPositions.push(openPosition);
    }

    return {
      closedTrades,
      openPositions,
      unmatchedBuys,
      unmatchedSells,
    }
  }

  /**
   * Create a new average lot
   */
  private createNewAverageLot(activity: ActivityDetails, symbol: string): AverageLot {
    return {
      symbol,
      totalQuantity: activity.quantity,
      totalCostBasis: activity.unitPrice * activity.quantity,
      averagePrice: activity.unitPrice,
      activities: [activity],
      remainingQuantity: activity.quantity,
      dividends: [],
    }
  }

  /**
   * Update existing average lot with new buy activity
   */
  private updateAverageLot(averageLot: AverageLot, activity: ActivityDetails): void {
    const newTotalQuantity = averageLot.remainingQuantity + activity.quantity
    const newTotalCostBasis = 
      (averageLot.averagePrice * averageLot.remainingQuantity) + 
      (activity.unitPrice * activity.quantity)
    
    averageLot.totalQuantity += activity.quantity
    averageLot.remainingQuantity = newTotalQuantity
    averageLot.totalCostBasis = newTotalCostBasis
    averageLot.averagePrice = newTotalCostBasis / newTotalQuantity
    averageLot.activities.push(activity)
  }

  /**
   * Match trades using FIFO or LIFO method
   */
  private matchSymbolTradesSpecific(
    symbol: string, 
    activities: ActivityDetails[],
    dividends: ActivityDetails[] = []
  ): TradeMatchResult {
    const closedTrades: ClosedTrade[] = []
    const openPositions: OpenPosition[] = []
    const unmatchedBuys: ActivityDetails[] = []
    const unmatchedSells: ActivityDetails[] = []

    const longLots: Lot[] = []
    const shortLots: Lot[] = []

    for (const activity of activities) {
      const activityType = activity.activityType;

      if (activityType === "BUY" || activityType === "BUY_COVER") {
        let buyQuantityRemaining = activity.quantity;

        // If short positions exist, this BUY/BUY_COVER closes them first
        while (buyQuantityRemaining > 0 && shortLots.length > 0) {
          const lotIndex = this.lotMethod === "FIFO" ? 0 : shortLots.length - 1;
          const shortLot = shortLots[lotIndex];
          const matchedQuantity = Math.min(buyQuantityRemaining, shortLot.remainingQuantity);

          const closedTrade = this.createClosedTrade(
            shortLot.activity, // Entry (SELL_SHORT)
            activity,         // Exit (BUY_COVER)
            matchedQuantity,
            symbol,
            shortLot.dividends,
            true // isShortTrade
          );
          closedTrades.push(closedTrade);

          buyQuantityRemaining -= matchedQuantity;
          shortLot.remainingQuantity -= matchedQuantity;

          if (shortLot.remainingQuantity <= 0) {
            shortLots.splice(lotIndex, 1);
          }
        }

        // If quantity remains, it opens a new long position
        if (buyQuantityRemaining > 0) {
          const buyActivityForLong = { ...activity, quantity: buyQuantityRemaining };
          const lot = this.createLot(buyActivityForLong, dividends);
          longLots.push(lot);
        }

      } else if (activityType === "SELL" || activityType === "SELL_SHORT") {
        let sellQuantityRemaining = activity.quantity

        // If long positions exist, this SELL closes them first
        while (sellQuantityRemaining > 0 && longLots.length > 0) {
          const lotIndex = this.lotMethod === "FIFO" ? 0 : longLots.length - 1;
          const longLot = longLots[lotIndex];
          const matchedQuantity = Math.min(sellQuantityRemaining, longLot.remainingQuantity);

          const closedTrade = this.createClosedTrade(
            longLot.activity, // Entry (BUY)
            activity,         // Exit (SELL)
            matchedQuantity,
            symbol,
            longLot.dividends
          );
          closedTrades.push(closedTrade);

          sellQuantityRemaining -= matchedQuantity;
          longLot.remainingQuantity -= matchedQuantity;

          if (longLot.remainingQuantity <= 0) {
            longLots.splice(lotIndex, 1);
          }
        }

        // If quantity remains, it opens a new short position
        if (sellQuantityRemaining > 0) {
          const sellActivityForShort = { ...activity, quantity: sellQuantityRemaining };
          const lot = this.createLot(sellActivityForShort, dividends);
          shortLots.push(lot);
        }
      }
    }

    // Create open long positions from remaining lots
    for (const lot of longLots) {
      if (lot.remainingQuantity > 0) {
        const openPosition = this.createOpenPosition(lot, symbol);
        openPositions.push(openPosition);
      }
    }

    // Create open short positions from remaining lots
    for (const lot of shortLots) {
      if (lot.remainingQuantity > 0) {
        const openPosition = this.createOpenPosition(lot, symbol, true);
        // Make quantity negative for display
        openPosition.quantity = -openPosition.quantity;
        openPositions.push(openPosition);
      }
    }

    return {
      closedTrades,
      openPositions,
      unmatchedBuys,
      unmatchedSells,
    }
  }

  /**
   * Create a new lot for specific matching
   */
  private createLot(activity: ActivityDetails, allDividends: ActivityDetails[]): Lot {
    const lot: Lot = {
      activity: activity,
      remainingQuantity: activity.quantity,
      originalQuantity: activity.quantity,
      dividends: [],
    };

    if (this.includeDividends) {
      lot.dividends = allDividends.filter(div => new Date(div.date) >= new Date(activity.date));
    }

    return lot;
  }

  /**
   * Create a closed trade from average lot
   */
  private createClosedTradeAverage(
    entryLot: AverageLot,
    exitActivity: ActivityDetails,
    quantity: number,
    symbol: string,
    isShortTrade = false,
  ): ClosedTrade {
    // Use the earliest buy date for entry date
    const entryDate = new Date(
      Math.min(...entryLot.activities.map(a => new Date(a.date).getTime()))
    )
    const exitDate = new Date(exitActivity.date)
    const holdingPeriodDays = differenceInDays(exitDate, entryDate)

    // Calculate fees proportionally
    const totalEntryFees = entryLot.activities.reduce((sum, activity) => sum + activity.fee, 0)
    const entryFeeAllocation = this.includeFees 
      ? (totalEntryFees * quantity) / entryLot.totalQuantity 
      : 0
    
    // Sell fees: Calculate proportionally for this sell
    const exitFeeAllocation = this.includeFees 
      ? (exitActivity.fee * quantity) / exitActivity.quantity 
      : 0
    const totalFees = entryFeeAllocation + exitFeeAllocation

    // Calculate dividends for this trade
    let totalDividends = this.calculateTradeDividends(
      entryDate,
      exitDate,
      quantity,
      entryLot.dividends
    )

    // Calculate P/L using average cost
    const entryValue = entryLot.averagePrice * quantity
    const exitValue = exitActivity.unitPrice * quantity

    // For short trades, you pay dividends, so it's a cost.
    if (isShortTrade) totalDividends = -totalDividends;

    const realizedPL = isShortTrade 
      ? entryValue - exitValue - totalFees + totalDividends
      : exitValue - entryValue - totalFees + totalDividends;
    const costBasis = entryValue;
    const returnPercent = costBasis > 0 ? realizedPL / costBasis : 0

    const entryActivity = entryLot.activities[0];
    const buyActivityId = isShortTrade ? exitActivity.id : entryActivity.id;
    const sellActivityId = isShortTrade ? entryActivity.id : exitActivity.id;

    return {
      id: `avg-${entryLot.activities[0].id}-${exitActivity.id}-${Date.now()}`,
      symbol,
      assetName: exitActivity.assetName || undefined,
      entryDate,
      exitDate,
      quantity,
      entryPrice: entryLot.averagePrice,
      exitPrice: exitActivity.unitPrice,
      totalFees,
      totalDividends,
      realizedPL,
      returnPercent,
      holdingPeriodDays,
      accountId: entryActivity.accountId,
      accountName: entryActivity.accountName,
      currency: entryActivity.currency,
      buyActivityId,
      sellActivityId,
    }
  }

  /**
   * Create an open position from average lot
   */
  private createOpenPositionAverage(averageLot: AverageLot, symbol: string, isShort = false): OpenPosition {
    const openDate = new Date(
      Math.min(...averageLot.activities.map(a => new Date(a.date).getTime()))
    )
    const daysOpen = differenceInDays(new Date(), openDate)

    // Calculate total dividends for open position
    let totalDividends = this.includeDividends
      ? averageLot.dividends.reduce((sum, div) => sum + div.amount, 0)
      : 0
    
    // For short positions, dividends are a cost
    if (isShort) totalDividends = -totalDividends;

    // Initial values (will be updated with real market prices)
    const currentPrice = averageLot.averagePrice
    const marketValue = currentPrice * averageLot.remainingQuantity
    const costBasis = averageLot.averagePrice * averageLot.remainingQuantity

    const unrealizedPL = isShort
      ? costBasis - marketValue + totalDividends
      : marketValue - costBasis + totalDividends;

    const unrealizedReturnPercent = costBasis > 0 ? unrealizedPL / costBasis : 0

    const latestActivity = averageLot.activities[averageLot.activities.length - 1]

    return {
      id: `avg-open-${averageLot.activities[0].id}-${Date.now()}`,
      symbol,
      assetName: latestActivity.assetName || undefined,
      quantity: averageLot.remainingQuantity,
      averageCost: averageLot.averagePrice,
      currentPrice,
      marketValue,
      unrealizedPL,
      unrealizedReturnPercent,
      totalDividends,
      daysOpen,
      openDate,
      accountId: latestActivity.accountId,
      accountName: latestActivity.accountName,
      currency: latestActivity.currency,
      activityIds: averageLot.activities.map(a => a.id),
    }
  }

  /**
   * Create a closed trade from specific lot matching
   */
  private createClosedTrade(
    entryActivity: ActivityDetails,
    exitActivity: ActivityDetails,
    quantity: number,
    symbol: string,
    dividends: ActivityDetails[] = [],
    isShortTrade = false,
  ): ClosedTrade {
    const entryDate = new Date(entryActivity.date)
    const exitDate = new Date(exitActivity.date)
    const holdingPeriodDays = differenceInDays(exitDate, entryDate)

    // Calculate fees proportionally
    const buyFeeAllocation = this.includeFees 
      ? (entryActivity.fee * quantity) / entryActivity.quantity 
      : 0
    const sellFeeAllocation = this.includeFees 
      ? (exitActivity.fee * quantity) / exitActivity.quantity 
      : 0
    const totalFees = buyFeeAllocation + sellFeeAllocation

    // Calculate dividends for this trade
    let totalDividends = this.calculateTradeDividends(
      entryDate,
      exitDate,
      quantity,
      dividends
    )

    // Calculate P/L
    const entryValue = entryActivity.unitPrice * quantity
    const exitValue = exitActivity.unitPrice * quantity

    // For short trades, you pay dividends, so it's a cost.
    if (isShortTrade) totalDividends = -totalDividends;

    const realizedPL = isShortTrade
      ? entryValue - exitValue - totalFees + totalDividends
      : exitValue - entryValue - totalFees + totalDividends;
    const costBasis = entryValue;
    const returnPercent = costBasis > 0 ? realizedPL / costBasis : 0

    return {
      id: `${entryActivity.id}-${exitActivity.id}-${Date.now()}`,
      symbol,
      assetName: entryActivity.assetName || undefined,
      entryDate,
      exitDate,
      quantity,
      entryPrice: entryActivity.unitPrice,
      exitPrice: exitActivity.unitPrice,
      totalFees,
      totalDividends,
      realizedPL,
      returnPercent,
      holdingPeriodDays,
      accountId: entryActivity.accountId,
      accountName: entryActivity.accountName,
      currency: entryActivity.currency,
      buyActivityId: isShortTrade ? exitActivity.id : entryActivity.id,
      sellActivityId: isShortTrade ? entryActivity.id : exitActivity.id,
    }
  }

  /**
   * Create an open position from a lot
   */
  private createOpenPosition(lot: Lot, symbol: string, isShort = false): OpenPosition {
    const openDate = new Date(lot.activity.date)
    const daysOpen = differenceInDays(new Date(), openDate)

    // Calculate total dividends for open position
    let totalDividends = this.includeDividends
      ? lot.dividends.reduce((sum, div) => sum + div.amount, 0)
      : 0

    // For short positions, dividends are a cost
    if (isShort) totalDividends = -totalDividends;

    // Initial values (will be updated with real market prices)
    const currentPrice = lot.activity.unitPrice
    const marketValue = currentPrice * lot.remainingQuantity
    const costBasis = lot.activity.unitPrice * lot.remainingQuantity

    const unrealizedPL = isShort
      ? costBasis - marketValue + totalDividends
      : marketValue - costBasis + totalDividends;

    const unrealizedReturnPercent = costBasis > 0 ? unrealizedPL / costBasis : 0

    return {
      id: `${lot.activity.id}-open-${Date.now()}`,
      symbol,
      assetName: lot.activity.assetName || undefined,
      quantity: lot.remainingQuantity,
      averageCost: lot.activity.unitPrice,
      currentPrice,
      marketValue,
      unrealizedPL,
      unrealizedReturnPercent,
      totalDividends,
      daysOpen,
      openDate,
      accountId: lot.activity.accountId,
      accountName: lot.activity.accountName,
      currency: lot.activity.currency,
      activityIds: [lot.activity.id],
    }
  }

  /**
   * Calculate total dividends for a trade based on holding period
   */
  private calculateTradeDividends(
    entryDate: Date,
    exitDate: Date,
    quantity: number,
    dividends: ActivityDetails[]
  ): number {
    if (!this.includeDividends || dividends.length === 0) return 0

    return dividends
      .filter(dividend => {
        const divDate = new Date(dividend.date)
        return divDate >= entryDate && divDate <= exitDate
      })
      .reduce((sum, dividend) => {
        // For dividends, the total amount is in the 'amount' field, not unitPrice * quantity
        return sum + dividend.amount
      }, 0)
  }
}