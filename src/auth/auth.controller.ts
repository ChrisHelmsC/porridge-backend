import { Body, Controller, Post, Request, UseGuards, Res, Get, HttpCode, Req, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LocalAuthGuard } from './local.guard';
import { UsersService } from '../users/users.service';
import { IsString, MinLength, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { JwtAuthGuard } from './jwt.guard';

class SignupDto {
	@IsString()
	@MinLength(3)
	@MaxLength(32)
	username: string;

	@IsString()
	@MinLength(6)
	@MaxLength(128)
	password: string;
}

class LoginDto {
	@IsString()
	username: string;

	@IsString()
	password: string;
}

@Controller('auth')
export class AuthController {
	constructor(
		private readonly authService: AuthService,
		private readonly usersService: UsersService,
	) {}

	@Post('signup')
	async signup(@Body() body: SignupDto, @Res({ passthrough: true }) res: Response) {
		const user = await this.usersService.createUser(body.username, body.password);
		const tokens = await this.authService.login({ id: user.id, username: user.username, tokenVersion: user.tokenVersion });
		res.cookie('access_token', tokens.access_token, { httpOnly: true, sameSite: 'lax', secure: false });
		res.cookie('refresh_token', tokens.refresh_token, { httpOnly: true, sameSite: 'lax', secure: false });
		return { message: 'signed_in' };
	}

	@UseGuards(LocalAuthGuard)
	@Post('login')
	@HttpCode(200)
	async login(@Request() req: any, @Body() _body: LoginDto, @Res({ passthrough: true }) res: Response) {
		const tokens = await this.authService.login({ id: req.user.id, username: req.user.username, tokenVersion: req.user.tokenVersion ?? 0 });
		res.cookie('access_token', tokens.access_token, { httpOnly: true, sameSite: 'lax', secure: false });
		res.cookie('refresh_token', tokens.refresh_token, { httpOnly: true, sameSite: 'lax', secure: false });
		return { message: 'signed_in' };
	}

	@UseGuards(JwtAuthGuard)
	@Get('me')
	async me(@Request() req: any) {
		return { id: req.user.userId, username: req.user.username };
	}

	@Post('logout')
	@HttpCode(200)
	async logout(@Res({ passthrough: true }) res: Response) {
		res.clearCookie('access_token');
		res.clearCookie('refresh_token');
		return { message: 'signed_out' };
	}

	@Post('refresh')
	@HttpCode(200)
	async refresh(@Req() req: any, @Res({ passthrough: true }) res: Response) {
		const token = req?.cookies?.['refresh_token'] || (req?.headers?.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
		if (!token) throw new UnauthorizedException('No refresh token');
		try {
			const decoded: any = await (this.authService as any)['jwtService'].verifyAsync(token, {});
			const userId = decoded?.sub;
			const tokenVersion = decoded?.tokenVersion ?? 0;
			const user = await this.usersService.findById(userId);
			if (!user || !user.refreshTokenHash) throw new UnauthorizedException('Invalid refresh token');
			const ok = await require('bcrypt').compare(token, user.refreshTokenHash);
			if (!ok) throw new UnauthorizedException('Invalid refresh token');
			const tokens = await this.authService.rotateRefresh(userId, tokenVersion);
			res.cookie('access_token', tokens.access_token, { httpOnly: true, sameSite: 'lax', secure: false });
			res.cookie('refresh_token', tokens.refresh_token, { httpOnly: true, sameSite: 'lax', secure: false });
			return { message: 'refreshed' };
		} catch (e) {
			res.clearCookie('access_token');
			res.clearCookie('refresh_token');
			throw new UnauthorizedException('Refresh failed');
		}
	}
}
