import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleService } from './google.service';
import { SessionRevocationService } from './session-revocation.service';
import { JwtStrategy } from './strategies';
import { TokenService } from './token.service';

@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' }), JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, TokenService, GoogleService, JwtStrategy, SessionRevocationService],
  exports: [AuthService, TokenService, SessionRevocationService],
})
export class AuthModule {}
