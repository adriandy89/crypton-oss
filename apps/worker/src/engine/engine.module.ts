import { Module } from '@nestjs/common';
import { MarketDataModule } from '../marketdata';
import { AccountHub } from './account-hub.service';
import { BotStore } from './bot-store';
import { CommandInbox } from './command-inbox.service';
import { CredentialsService } from './credentials.service';
import { EngineService } from './engine.service';
import { LeaseService } from './lease.service';
import { PaperStateStore } from './paper-state.store';
import { PortfolioSnapshotsService } from './portfolio-snapshots.service';
import { RetentionService } from './retention.service';

@Module({
  imports: [MarketDataModule],
  providers: [
    EngineService,
    BotStore,
    LeaseService,
    CredentialsService,
    CommandInbox,
    AccountHub,
    PaperStateStore,
    RetentionService,
    PortfolioSnapshotsService,
  ],
  exports: [EngineService, LeaseService],
})
export class EngineModule {}
